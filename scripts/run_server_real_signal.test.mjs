#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const testRoot = await mkdtemp(
  path.join(os.tmpdir(), "codex-web-real-signal-"),
);
const childPidFile = path.join(testRoot, "codex-child.pid");
const fakeCodexPath = path.join(testRoot, "codex");

function waitForExit(child, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("server launcher did not exit after SIGTERM")),
      timeoutMs,
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function waitUntil(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function canConnect(port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

await writeFile(
  fakeCodexPath,
  [
    "#!/usr/bin/env node",
    'require("node:fs").writeFileSync(process.env.CODEX_TEST_CHILD_PID_FILE, String(process.pid));',
    "// Ignore graceful termination so the host escalation path is exercised.",
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1_000);",
    "",
  ].join("\n"),
);
await chmod(fakeCodexPath, 0o755);

const port = await reservePort();
const launcher = spawn(
  process.execPath,
  [path.join(repositoryRoot, "scripts/run_server.mjs"), "--port", String(port)],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CODEX_CLI_PATH: fakeCodexPath,
      CODEX_TEST_CHILD_PID_FILE: childPidFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
launcher.stdout.on("data", (chunk) => (output += chunk));
launcher.stderr.on("data", (chunk) => (output += chunk));

let codexPid;
let terminationStarted = false;
try {
  await waitUntil(
    async () => output.includes(`http://127.0.0.1:${port}`),
    "real server readiness",
  );
  await waitUntil(async () => {
    try {
      codexPid = Number(await readFile(childPidFile, "utf8"));
      return Number.isInteger(codexPid) && codexPid > 0;
    } catch {
      return false;
    }
  }, "upstream Codex child");
  assert.equal(await canConnect(port), true);
  assert.equal(processExists(codexPid), true);

  terminationStarted = true;
  launcher.kill("SIGTERM");
  const result = await waitForExit(launcher);
  assert.deepEqual(result, { code: 0, signal: null });
  await waitUntil(async () => !(await canConnect(port)), "server port closure");
  await waitUntil(() => !processExists(codexPid), "Codex child termination");
} finally {
  if (launcher.exitCode === null && launcher.signalCode === null) {
    if (!terminationStarted) launcher.kill("SIGTERM");
    try {
      await waitForExit(launcher, 3_000);
    } catch {
      launcher.kill("SIGKILL");
      await waitForExit(launcher, 1_000).catch(() => undefined);
    }
  }
  if (codexPid && processExists(codexPid)) process.kill(codexPid, "SIGKILL");
  await rm(testRoot, { recursive: true, force: true });
}

console.log(
  "Real server launcher shuts down the bridge and upstream Codex child.",
);

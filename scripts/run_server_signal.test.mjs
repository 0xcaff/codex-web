#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const testRoot = await mkdtemp(path.join(os.tmpdir(), "codex-web-signal-"));
const stateFile = path.join(testRoot, "child.json");
const runServerUrl = pathToFileURL(
  path.join(repositoryRoot, "scripts/run_server.mjs"),
).href;
const childProgram = [
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const server = net.createServer();",
  "server.listen(0, '127.0.0.1', () => {",
  "const address = server.address();",
  "fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({pid: process.pid, port: address.port}));",
  "});",
].join("");
const launcherProgram = [
  `import { runChild } from ${JSON.stringify(runServerUrl)};`,
  "process.exitCode = await runChild(process.execPath, ['-e', process.env.CHILD_PROGRAM], { env: process.env });",
].join("");

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForState() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(stateFile, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("signal-test child did not become ready");
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

const launcher = spawn(
  process.execPath,
  ["--input-type=module", "-e", launcherProgram],
  {
    env: { ...process.env, CHILD_PROGRAM: childProgram, STATE_FILE: stateFile },
    stdio: "ignore",
  },
);

try {
  const state = await waitForState();
  assert.equal(await canConnect(state.port), true);
  launcher.kill("SIGTERM");
  await waitForExit(launcher);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await canConnect(state.port), false);
  assert.throws(() => process.kill(state.pid, 0));
} finally {
  if (launcher.exitCode === null && launcher.signalCode === null) {
    launcher.kill("SIGKILL");
  }
  await rm(testRoot, { recursive: true, force: true });
}

console.log("Server launcher forwards termination to its active child.");

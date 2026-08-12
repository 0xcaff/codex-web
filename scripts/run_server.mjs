#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

class LauncherError extends Error {}

export async function findExecutableOnPath(name, pathValue) {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return undefined;
}

export async function createServerLaunch(args, env = process.env) {
  const explicit = env.CODEX_CLI_PATH?.trim();
  const codexCliPath =
    explicit || (await findExecutableOnPath("codex", env.PATH));
  if (!codexCliPath) {
    throw new LauncherError(
      "Codex CLI not found. Install `codex` on PATH or set CODEX_CLI_PATH explicitly.",
    );
  }
  return {
    command: process.execPath,
    args: [path.join(repositoryRoot, "src/server/main.js"), ...args],
    env: { ...env, CODEX_CLI_PATH: codexCliPath },
  };
}

export function parseLauncherArgs(rawArgs) {
  return rawArgs[0] === "--rebuild"
    ? { rebuild: true, serverArgs: rawArgs.slice(1) }
    : { rebuild: false, serverArgs: rawArgs };
}

export function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    const forwardSignal = (signal) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    const cleanup = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

export async function main(rawArgs) {
  const { rebuild, serverArgs } = parseLauncherArgs(rawArgs);
  if (rebuild) {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const rebuildCode = await runChild(npmCommand, ["run", "rebuild"], {
      cwd: repositoryRoot,
      env: process.env,
    });
    if (rebuildCode !== 0) return rebuildCode;
  }
  const launch = await createServerLaunch(serverArgs);
  return await runChild(launch.command, launch.args, {
    cwd: repositoryRoot,
    env: launch.env,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message =
        error instanceof LauncherError
          ? error.message
          : "Server launcher failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

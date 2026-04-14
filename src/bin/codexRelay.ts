#!/usr/bin/env node
/* eslint-disable no-console */

import fs from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { WebSocket, type RawData } from "ws";

const DEFAULT_WS_URL = "ws://codex-agent.internal.0xcaff.xyz:80";
const DEFAULT_LOG_DIR = "/tmp/codex-wscat-launcher";

type RelayOptions = {
  argv: string[];
  wsUrl: string;
  logDir: string;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  codexRelay.ts [--ws-url <url>] [--log-dir <dir>] app-server [extra args ignored]",
      "",
      "Defaults:",
      `  --ws-url ${DEFAULT_WS_URL}`,
      `  --log-dir ${DEFAULT_LOG_DIR}`,
      "",
      "Environment overrides:",
      "  CODEX_RELAY_WS_URL",
      "  CODEX_RELAY_LOG_DIR",
    ].join("\n"),
  );
}

function parseArgs(rawArgs: string[]): RelayOptions {
  let wsUrl = process.env.CODEX_RELAY_WS_URL ?? DEFAULT_WS_URL;
  let logDir = process.env.CODEX_RELAY_LOG_DIR ?? DEFAULT_LOG_DIR;
  const argv: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--ws-url") {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error("Missing value for --ws-url");
      }
      wsUrl = value;
      index += 1;
      continue;
    }
    if (arg === "--log-dir") {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error("Missing value for --log-dir");
      }
      logDir = value;
      index += 1;
      continue;
    }
    argv.push(arg);
  }

  return { argv, wsUrl, logDir };
}

function appendBestEffort(filePath: string, text: string): void {
  try {
    fs.appendFileSync(filePath, text, "utf8");
  } catch {
    // best effort logging only
  }
}

function decodeWebSocketPayload(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.argv[0] !== "app-server") {
    console.error("codex launcher bridge only supports app-server mode");
    process.exitCode = 64;
    return;
  }

  fs.mkdirSync(options.logDir, { recursive: true });
  const invocationLog = `${options.logDir}/invocations.log`;
  const stdinLog = `${options.logDir}/stdin.log`;
  const stdoutLog = `${options.logDir}/stdout.log`;
  const stderrLog = `${options.logDir}/stderr.log`;

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const escapedArgs = options.argv.map((arg) => JSON.stringify(arg)).join(" ");
  appendBestEffort(
    invocationLog,
    `[${now}] pid=${process.pid} cwd=${JSON.stringify(process.cwd())} argv0=${JSON.stringify(process.argv[1] ?? "")} argc=${options.argv.length} args=${escapedArgs}\n`,
  );

  const ws = new WebSocket(options.wsUrl);
  const pendingLines: string[] = [];
  let stdinEnded = false;

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  const sendLine = (line: string): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(line);
      return;
    }
    pendingLines.push(line);
  };

  rl.on("line", (line) => {
    appendBestEffort(stdinLog, `${line}\n`);
    sendLine(line);
  });

  rl.on("close", () => {
    stdinEnded = true;
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "stdin-eof");
    }
  });

  ws.on("open", () => {
    while (pendingLines.length > 0) {
      const line = pendingLines.shift();
      if (line !== undefined) {
        ws.send(line);
      }
    }
    if (stdinEnded) {
      ws.close(1000, "stdin-eof");
    }
  });

  ws.on("message", (data) => {
    const text = decodeWebSocketPayload(data);
    appendBestEffort(stdoutLog, `${text}\n`);
    process.stdout.write(`${text}\n`);
  });

  ws.on("error", (error) => {
    const message = `[ws-error] ${error instanceof Error ? error.message : String(error)}\n`;
    appendBestEffort(stderrLog, message);
    process.stderr.write(message);
  });

  ws.on("close", (code, reasonBuffer) => {
    const reason = reasonBuffer.toString("utf8");
    const line = `[ws-close] code=${code} reason=${JSON.stringify(reason)}\n`;
    appendBestEffort(stderrLog, line);
    if (code !== 1000) {
      process.stderr.write(line);
      process.exit(1);
      return;
    }
    process.exit(0);
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

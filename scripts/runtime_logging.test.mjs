#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const modulePath = path.join(repositoryRoot, "src/server/runtime-logging.js");
const child = spawnSync(
  process.execPath,
  [
    "-e",
    [
      "const logging = require(process.env.RUNTIME_LOGGING_MODULE);",
      "logging.installUpstreamConsolePolicy();",
      "console.log('secret-log-body');",
      "console.info('secret-account-data');",
      "console.warn('secret-local-path');",
      "console.error('secret-token');",
      "logging.operatorLog('codex-web listening at http://127.0.0.1:9999');",
      "logging.operatorError('[ipc-bridge] startup failed');",
    ].join(""),
  ],
  {
    encoding: "utf8",
    env: { ...process.env, RUNTIME_LOGGING_MODULE: modulePath },
  },
);

assert.equal(child.status, 0, child.stderr);
assert.equal(child.stdout, "codex-web listening at http://127.0.0.1:9999\n");
assert.equal(child.stderr, "[ipc-bridge] startup failed\n");

console.log(
  "Runtime logging suppresses upstream payloads and keeps operator output.",
);

#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServerLaunch, parseLauncherArgs } from "./run_server.mjs";

const explicitProxy = "/tmp/codex-web-test/proxy with spaces";
const launch = await createServerLaunch(["--port", "4321"], {
  PATH: "/definitely/not/used",
  CODEX_CLI_PATH: explicitProxy,
});

assert.equal(launch.env.CODEX_CLI_PATH, explicitProxy);
assert.deepEqual(launch.args.slice(-2), ["--port", "4321"]);

const child = spawnSync(
  process.execPath,
  ["-e", "process.stdout.write(process.env.CODEX_CLI_PATH || '')"],
  { encoding: "utf8", env: launch.env },
);
assert.equal(child.status, 0);
assert.equal(child.stdout, explicitProxy);
assert.equal(child.stderr, "");
assert.deepEqual(parseLauncherArgs(["--rebuild", "--port", "4567"]), {
  rebuild: true,
  serverArgs: ["--port", "4567"],
});
await assert.rejects(
  createServerLaunch([], { PATH: "", CODEX_CLI_PATH: "" }),
  /Codex CLI not found/,
);

console.log("Server launcher preserves explicit Codex proxy and arguments.");

#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

const runtimeOutputs = ["src/server/main.js", "src/shared/ipc-protocol.js"];
for (const output of runtimeOutputs) {
  if (!existsSync(output))
    throw new Error(`Missing server build output: ${output}`);
}

const emittedTests = ["src/server", "src/shared"]
  .flatMap(listFiles)
  .filter((file) => /\.test\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(file));
if (emittedTests.length > 0) {
  throw new Error(`Server build emitted tests: ${emittedTests.join(", ")}`);
}

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const packageFiles = packed[0]?.files?.map((file) => file.path) ?? [];
const packagedTests = packageFiles.filter((file) => /\.test\./.test(file));
if (packagedTests.length > 0) {
  throw new Error(`Package would include tests: ${packagedTests.join(", ")}`);
}
for (const output of runtimeOutputs) {
  if (!packageFiles.includes(output)) {
    throw new Error(`Package is missing runtime output: ${output}`);
  }
}
console.log("Server build emits runtime modules without packaging tests.");

#!/usr/bin/env node
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

const roots = ["src/server", "src/shared"].map((directory) =>
  path.resolve(directory),
);
const suffixes = [".js", ".js.map", ".d.ts", ".d.ts.map"];

function removeOutputsForTypescriptSources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeOutputsForTypescriptSources(entryPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const emittedBase = entryPath.slice(0, -3);
    for (const suffix of suffixes) {
      const emittedPath = `${emittedBase}${suffix}`;
      if (existsSync(emittedPath)) unlinkSync(emittedPath);
    }
  }
}

for (const root of roots) removeOutputsForTypescriptSources(root);

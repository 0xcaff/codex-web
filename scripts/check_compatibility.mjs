#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyPatchSeries,
  getPatchSeries,
  patchTargets,
} from "./patch_series.mjs";

const root = process.cwd();
const extractedRoot = path.resolve(process.argv[2] ?? "scratch/asar");
const patchesDirectory = path.join(root, "patches");
if (!existsSync(extractedRoot)) {
  throw new Error(`Pinned extracted tree is missing: ${extractedRoot}`);
}

const series = getPatchSeries(root);
const report = {
  extractedRoot,
  patches: [],
  budgets: { files: 0, bytes: 0, startupMainBundles: 0 },
};
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-web-compat-"));
const validationTree = path.join(temporaryRoot, "asar");
mkdirSync(validationTree);

try {
  for (const patchFile of series) {
    const source = readFileSync(path.join(patchesDirectory, patchFile), "utf8");
    const targets = patchTargets(source);
    if (targets.length === 0 || new Set(targets).size !== targets.length) {
      throw new Error(
        `${patchFile}: expected one unique target entry per patch hunk`,
      );
    }
    for (const target of targets) {
      const sourcePath = path.join(extractedRoot, target);
      if (!existsSync(sourcePath)) {
        throw new Error(`${patchFile}: missing expected target ${target}`);
      }
      const copiedPath = path.join(validationTree, target);
      mkdirSync(path.dirname(copiedPath), { recursive: true });
      cpSync(sourcePath, copiedPath);
    }
    report.patches.push({ patchFile, targets });
  }

  // Patches overlap. Validate their real, ordered inverse on a disposable
  // copy, rather than checking each patch against a state modified by later
  // patches. This never rewrites the extracted fixture.
  applyPatchSeries({
    tree: validationTree,
    patchDirectory: patchesDirectory,
    series,
    reverse: true,
  });
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

const stack = [extractedRoot];
while (stack.length > 0) {
  const directory = stack.pop();
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) stack.push(entryPath);
    else {
      report.budgets.files += 1;
      report.budgets.bytes += stat.size;
      if (/^main-[^/]+\.js$/.test(entry))
        report.budgets.startupMainBundles += 1;
    }
  }
}
console.log(JSON.stringify(report, null, 2));

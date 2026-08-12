#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const extractedRoot = path.resolve(process.argv[2] ?? "scratch/asar");
const patchesDirectory = path.join(root, "patches");
const patchFiles = readdirSync(patchesDirectory)
  .filter((file) => file.endsWith(".patch"))
  .sort();

if (!existsSync(extractedRoot)) {
  throw new Error(`Pinned extracted tree is missing: ${extractedRoot}`);
}

const report = {
  extractedRoot,
  patches: [],
  budgets: { files: 0, bytes: 0, startupMainBundles: 0 },
};
for (const patchFile of patchFiles) {
  const patchPath = path.join(patchesDirectory, patchFile);
  const source = readFileSync(patchPath, "utf8");
  const targets = [...source.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(
    (match) => match[1],
  );
  if (targets.length === 0 || new Set(targets).size !== targets.length) {
    throw new Error(
      `${patchFile}: expected one unique target entry per patch hunk`,
    );
  }
  for (const target of targets) {
    if (!existsSync(path.join(extractedRoot, target))) {
      throw new Error(`${patchFile}: missing expected target ${target}`);
    }
  }
  // Reverse dry-run uses the patch hunk context as its pinned anchor check;
  // it changes nothing and rejects zero or ambiguous matches.
  const checked = spawnSync(
    "patch",
    [
      "--batch",
      "--dry-run",
      "--reverse",
      "--strip",
      "1",
      "--directory",
      extractedRoot,
    ],
    { input: source, encoding: "utf8" },
  );
  if (checked.status !== 0) {
    throw new Error(
      `${patchFile}: target/anchor validation failed\n${checked.stderr || checked.stdout}`,
    );
  }
  report.patches.push({ patchFile, targets });
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

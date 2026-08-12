#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function patchTargets(source) {
  return [...source.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
}

export function getPatchSeries(root) {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "compatibility.json"), "utf8"),
  );
  const series = manifest.patchSeries;
  if (
    !Array.isArray(series) ||
    series.some((patch) => typeof patch !== "string")
  ) {
    throw new Error(
      "compatibility.json patchSeries must be an ordered string array",
    );
  }
  const available = readdirSync(path.join(root, "patches"))
    .filter((file) => file.endsWith(".patch"))
    .sort();
  if (
    new Set(series).size !== series.length ||
    series.length !== available.length ||
    [...series].sort().some((patch, index) => patch !== available[index])
  ) {
    throw new Error(
      "compatibility.json patchSeries must contain every patch exactly once",
    );
  }
  return series;
}

export function applyPatchSeries({
  tree,
  patchDirectory,
  series,
  reverse = false,
}) {
  const ordered = reverse ? [...series].reverse() : series;
  for (const patchFile of ordered) {
    const patchPath = path.join(patchDirectory, patchFile);
    const checked = spawnSync(
      "patch",
      [
        "--batch",
        reverse ? "--reverse" : "--forward",
        "--strip",
        "1",
        "--directory",
        tree,
      ],
      { input: readFileSync(patchPath, "utf8"), encoding: "utf8" },
    );
    if (checked.status !== 0) {
      throw new Error(
        `${patchFile}: target/anchor validation failed\n${checked.stderr || checked.stdout}`,
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, tree] = process.argv.slice(2);
  if (mode !== "apply" || !tree) {
    throw new Error("Usage: patch_series.mjs apply <extracted-tree>");
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  applyPatchSeries({
    tree: path.resolve(tree),
    patchDirectory: path.join(root, "patches"),
    series: getPatchSeries(root),
  });
}

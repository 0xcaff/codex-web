#!/usr/bin/env node
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatchSeries } from "./patch_series.mjs";

const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-web-patch-series-"));
const patches = path.join(fixture, "patches");
const tree = path.join(fixture, "tree");
mkdirSync(patches);
mkdirSync(tree);

try {
  writeFileSync(path.join(tree, "value.txt"), "baz\n");
  writeFileSync(
    path.join(patches, "first.patch"),
    "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-foo\n+bar\n",
  );
  writeFileSync(
    path.join(patches, "second.patch"),
    "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-bar\n+baz\n",
  );
  applyPatchSeries({
    tree,
    patchDirectory: patches,
    series: ["first.patch", "second.patch"],
    reverse: true,
  });
  if (readFileSync(path.join(tree, "value.txt"), "utf8") !== "foo\n") {
    throw new Error(
      "overlapping reverse patch fixture did not restore the base",
    );
  }
  writeFileSync(path.join(tree, "value.txt"), "moved\n");
  let failed = false;
  try {
    applyPatchSeries({
      tree,
      patchDirectory: patches,
      series: ["first.patch", "second.patch"],
      reverse: true,
    });
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("moved anchor fixture unexpectedly passed");
  console.log("Patch series overlap and missing-anchor fixtures passed.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

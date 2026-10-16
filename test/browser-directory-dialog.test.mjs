import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseOneDirectory } from "../src/browser/directory-dialog-bridge.ts";

test("browser picker sends a single selected directory", async () => {
  const paths = await chooseOneDirectory(async () => "/home/example/project");
  assert.deepEqual(paths, ["/home/example/project"]);
});

test("canceling the browser picker sends no directories", async () => {
  const paths = await chooseOneDirectory(async () => null);
  assert.deepEqual(paths, []);
});

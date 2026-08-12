#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSha256Sri, verifyArchive } from "./verify_archive.mjs";

const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-web-archive-"));
const archive = path.join(fixture, "archive.zip");
const contents = Buffer.from("fixture archive");
const sri = `sha256-${createHash("sha256").update(contents).digest("base64")}`;

try {
  writeFileSync(archive, contents);
  await verifyArchive(archive, sri);

  writeFileSync(archive, Buffer.from("corrupt archive"));
  await expectRejects(() => verifyArchive(archive, sri), "mismatch");
  for (const malformed of [
    "sha512-value",
    "sha256-not base64",
    "sha256-AA==",
  ]) {
    try {
      parseSha256Sri(malformed);
      throw new Error(`Accepted malformed SRI: ${malformed}`);
    } catch (error) {
      if (String(error).includes(`Accepted malformed SRI`)) throw error;
    }
  }
  console.log("Archive verifier fixtures passed.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

async function expectRejects(action, expectedText) {
  try {
    await action();
  } catch (error) {
    if (String(error).includes(expectedText)) return;
    throw error;
  }
  throw new Error("Expected archive verification to fail");
}

#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

export function parseSha256Sri(value) {
  const match = /^sha256-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error("Expected an SRI sha256-base64 digest");
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 32)
    throw new Error("Expected a 32-byte SHA-256 digest");
  return digest;
}

export async function verifyArchive(filePath, expectedSri) {
  const expected = parseSha256Sri(expectedSri);
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", resolve);
    input.once("error", reject);
  });
  const actual = hash.digest();
  if (!timingSafeEqual(actual, expected)) {
    throw new Error(`Archive SHA-256 mismatch for ${filePath}`);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [filePath, expectedSri] = process.argv.slice(2);
  if (!filePath || !expectedSri) {
    throw new Error("Usage: verify_archive.mjs <file> <sha256-base64-sri>");
  }
  await verifyArchive(filePath, expectedSri);
  console.log(`Verified SHA-256 for ${filePath}`);
}

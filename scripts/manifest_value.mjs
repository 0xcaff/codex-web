#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(scriptDir, "../compatibility.json");
const key = process.argv[2];

if (!key) {
  throw new Error("Usage: manifest_value.mjs <dot.separated.key>");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const value = key.split(".").reduce((current, segment) => {
  if (!current || typeof current !== "object" || !(segment in current)) {
    throw new Error(`Missing compatibility manifest value: ${key}`);
  }
  return current[segment];
}, manifest);

if (typeof value !== "string") {
  throw new Error(`Compatibility manifest value must be a string: ${key}`);
}

process.stdout.write(`${value}\n`);

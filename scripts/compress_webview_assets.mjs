#!/usr/bin/env node

import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const webviewRoot = path.resolve(
  process.env.CODEX_WEBVIEW_ROOT ??
    path.join(repositoryRoot, "scratch", "asar", "webview"),
);
const minimumBytes = 1024;
// Quality 6 retains most transfer savings while avoiding the multi-minute CPU
// spike quality 11 caused for the upstream bundle.
const brotliQuality = 6;
const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesIn(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function writeIfWorthwhile(filename, extension, compressed) {
  const output = `${filename}${extension}`;
  if (compressed.length < (await readFile(filename)).length) {
    await writeFile(output, compressed, { mode: 0o644 });
  } else {
    await unlink(output).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const candidates = (await filesIn(webviewRoot)).filter((filename) => {
  const extension = path.extname(filename).toLowerCase();
  return (
    !filename.endsWith(".br") &&
    !filename.endsWith(".gz") &&
    compressibleExtensions.has(extension)
  );
});

console.log(
  `Precompressing ${candidates.length} web assets (Brotli quality ${brotliQuality})...`,
);

let compressedFiles = 0;
for (const filename of candidates) {
  const content = await readFile(filename);
  if (content.length < minimumBytes) {
    continue;
  }
  await writeIfWorthwhile(
    filename,
    ".br",
    brotliCompressSync(content, {
      params: { [constants.BROTLI_PARAM_QUALITY]: brotliQuality },
    }),
  );
  await writeIfWorthwhile(filename, ".gz", gzipSync(content, { mtime: 0 }));
  compressedFiles += 1;
}

console.log(`Precompressed ${compressedFiles} web assets.`);

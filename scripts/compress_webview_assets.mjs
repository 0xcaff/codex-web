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

for (const filename of await filesIn(webviewRoot)) {
  const extension = path.extname(filename).toLowerCase();
  if (
    filename.endsWith(".br") ||
    filename.endsWith(".gz") ||
    !compressibleExtensions.has(extension)
  ) {
    continue;
  }
  const content = await readFile(filename);
  if (content.length < minimumBytes) {
    continue;
  }
  await writeIfWorthwhile(
    filename,
    ".br",
    brotliCompressSync(content, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }),
  );
  await writeIfWorthwhile(filename, ".gz", gzipSync(content, { mtime: 0 }));
}

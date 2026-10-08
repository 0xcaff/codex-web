#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);
const extensions = new Set([".js", ".css", ".json", ".svg", ".wasm"]);

async function compressAssets(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (
        entry.isFile() &&
        extensions.has(path.extname(file).toLowerCase())
      )
        files.push(file);
    }
  }
  await visit(root);
  const result = { files: 0, originalBytes: 0, gzipBytes: 0, brotliBytes: 0 };
  let index = 0;
  async function worker() {
    while (index < files.length) {
      const file = files[index++];
      const original = await fs.readFile(file);
      if (original.length < 1024) {
        await Promise.all(
          [".gz", ".br"].map((suffix) => fs.rm(file + suffix, { force: true })),
        );
        continue;
      }
      const [gz, br] = await Promise.all([
        gzip(original, { level: 6 }),
        brotli(original, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
        }),
      ]);
      for (const [suffix, compressed] of [
        [".gz", gz],
        [".br", br],
      ]) {
        const target = file + suffix;
        if (compressed.length < original.length) {
          const temporary = target + ".build-" + process.pid;
          await fs.writeFile(temporary, compressed);
          await fs.rename(temporary, target);
        } else await fs.rm(target, { force: true });
      }
      result.files++;
      result.originalBytes += original.length;
      result.gzipBytes += Math.min(gz.length, original.length);
      result.brotliBytes += Math.min(br.length, original.length);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return result;
}

module.exports = { compressAssets };
if (require.main === module) {
  const root = path.resolve(
    process.argv[2] || path.join(__dirname, "../scratch/asar/webview"),
  );
  compressAssets(root)
    .then((result) =>
      console.log("Compressed web assets", JSON.stringify(result)),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

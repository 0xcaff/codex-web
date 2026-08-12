import path from "node:path";
import type { FastifyReply } from "fastify";

const NEVER_IMMUTABLE = new Set([".html", ".map", ".webmanifest", ".manifest"]);
const FINGERPRINTED_ASSET =
  /(?:^|[._-])[a-zA-Z0-9_-]{8,}\.(?:css|js|mjs|svg|png|jpe?g|gif|webp|woff2?|ttf|otf)$/;

function sourceFilename(filePath: string): string {
  return filePath.endsWith(".br") || filePath.endsWith(".gz")
    ? filePath.slice(0, filePath.lastIndexOf("."))
    : filePath;
}

export function staticCacheControl(filePath: string): string {
  const filename = path.basename(sourceFilename(filePath)).toLowerCase();
  const extension = path.extname(filename);
  if (
    NEVER_IMMUTABLE.has(extension) ||
    filename === "manifest.json" ||
    filename === "preload.js"
  ) {
    return "no-cache";
  }
  return FINGERPRINTED_ASSET.test(path.basename(sourceFilename(filePath)))
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

export function setStaticAssetHeaders(
  reply: FastifyReply,
  filePath: string,
): void {
  reply.header("cache-control", staticCacheControl(filePath));
}

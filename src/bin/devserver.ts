#!/usr/bin/env node
/* eslint-disable no-console */

import fs from "node:fs";
import path from "node:path";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

type ServerOptions = {
  rootDir: string;
  host: string;
  port: number;
  spaFallback: boolean;
};

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
};

const BRIDGE_MODULE_RELATIVE_PATH = "assets/dev-bridge.js";
const BRIDGE_MODULE_SCRIPT_TAG = `<script type="module" src="./${BRIDGE_MODULE_RELATIVE_PATH}"></script>`;

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  devserver [--root <dir>] [--host <host>] [--port <port>] [--no-spa-fallback]",
      "",
      "Defaults:",
      "  --root scratch/asar/webview",
      "  --host 127.0.0.1",
      "  --port 4173",
      "",
      "Examples:",
      "  yarn devserver",
      "  yarn devserver --port 3000",
      "  yarn devserver --root ./scratch/asar/webview",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseArgs(args: string[]): ServerOptions {
  const options: ServerOptions = {
    rootDir: path.resolve(process.cwd(), "scratch/asar/webview"),
    host: "127.0.0.1",
    port: 4173,
    spaFallback: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--root") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --root");
      }
      options.rootDir = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }

    if (arg === "--host") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --host");
      }
      options.host = value;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --port");
      }
      options.port = parsePort(value);
      index += 1;
      continue;
    }

    if (arg === "--no-spa-fallback") {
      options.spaFallback = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function ensureInsideRoot(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

function sendError(
  response: ServerResponse,
  statusCode: number,
  message: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

function resolveRequestPath(rootDir: string, requestPath: string): string {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = decodedPath.endsWith("/")
    ? `${decodedPath}index.html`
    : decodedPath;
  const absolutePath = path.resolve(rootDir, `.${normalizedPath}`);

  if (!ensureInsideRoot(rootDir, absolutePath)) {
    throw new Error("Path traversal blocked");
  }

  return absolutePath;
}

function statIfExists(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
): void {
  if (request.method === "HEAD") {
    response.statusCode = 200;
    response.setHeader("Content-Type", contentTypeFor(filePath));
    response.end();
    return;
  }

  if (
    path.extname(filePath).toLowerCase() === ".html" &&
    path.basename(filePath).toLowerCase() === "index.html"
  ) {
    const originalHtml = fs.readFileSync(filePath, "utf8");
    const htmlWithoutCsp = originalHtml.replace(
      /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi,
      "",
    );
    const htmlWithBridge = htmlWithoutCsp.includes(BRIDGE_MODULE_SCRIPT_TAG)
      ? htmlWithoutCsp
      : htmlWithoutCsp.replace(
          /<head>/i,
          `<head>\n    ${BRIDGE_MODULE_SCRIPT_TAG}`,
        );

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(htmlWithBridge);
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypeFor(filePath));

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    sendError(response, 500, "Failed to read file");
  });
  stream.pipe(response);
}

function createHandler(options: ServerOptions) {
  const indexHtmlPath = path.join(options.rootDir, "index.html");

  return (request: IncomingMessage, response: ServerResponse): void => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendError(response, 405, "Method Not Allowed");
      return;
    }

    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    let filePath: string;
    try {
      filePath = resolveRequestPath(options.rootDir, requestUrl.pathname);
    } catch {
      sendError(response, 403, "Forbidden");
      return;
    }

    const fileStat = statIfExists(filePath);
    if (fileStat?.isFile()) {
      serveFile(request, response, filePath);
      return;
    }

    if (options.spaFallback && path.extname(requestUrl.pathname) === "") {
      const indexStat = statIfExists(indexHtmlPath);
      if (indexStat?.isFile()) {
        serveFile(request, response, indexHtmlPath);
        return;
      }
    }

    sendError(response, 404, "Not Found");
  };
}

function main(args: string[]): void {
  const options = parseArgs(args);

  const rootStat = statIfExists(options.rootDir);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Webview root directory not found: ${options.rootDir}`);
  }
  const bridgeModulePath = path.join(
    options.rootDir,
    BRIDGE_MODULE_RELATIVE_PATH,
  );
  const bridgeStat = statIfExists(bridgeModulePath);
  if (!bridgeStat?.isFile()) {
    throw new Error(
      `Bridge module not found: ${bridgeModulePath}. Run 'yarn build:bridge' first.`,
    );
  }

  const server = http.createServer(createHandler(options));
  server.listen(options.port, options.host, () => {
    console.log(`Serving: ${options.rootDir}`);
    console.log(`URL: http://${options.host}:${options.port}`);
  });
}

main(process.argv.slice(2));

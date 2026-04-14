#!/usr/bin/env node
/* eslint-disable no-console */

import fs from "node:fs";
import path from "node:path";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

type ServerOptions = {
  rootDir: string;
  host: string;
  port: number;
  spaFallback: boolean;
};

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    };

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ) => Promise<unknown>;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ) => void;
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
const IPC_BRIDGE_PATH = "/__electron_ipc";
const MAIN_BRIDGE_PATH = path.resolve(
  process.cwd(),
  "scratch/asar/.vite/build/dev-main.js",
);

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function createIpcBridgeServer(server: http.Server): void {
  const bridgeState = getIpcMainBridgeState();
  const websocketServer = new WebSocketServer({
    server,
    path: IPC_BRIDGE_PATH,
  });
  const sockets = new Set<WebSocket>();

  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  };

  websocketServer.on("connection", (socket) => {
    sockets.add(socket);

    socket.on("close", () => {
      sockets.delete(socket);
    });

    socket.on("message", (rawData) => {
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      if (message.type === "ipc-renderer-send") {
        bridgeState.handleRendererSend?.(
          message.channel,
          message.args,
          message.sourceUrl,
        );
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        const { channel, requestId, args, sourceUrl } = message;
        Promise.resolve(
          bridgeState.handleRendererInvoke?.(channel, args, sourceUrl) ??
            Promise.reject(
              new Error(
                `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
              ),
            ),
        )
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: true,
              result,
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          });
      }
    });
  });
}

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

function ensureElectronLikeProcessContext(): void {
  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    resourcesPath?: string;
    type?: string;
  };
  processWithElectronFields.resourcesPath ??= path.resolve(
    process.cwd(),
    "scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

function loadMainBridgeModule(modulePath: string): void {
  ensureElectronLikeProcessContext();

  const moduleUrl = pathToFileURL(modulePath).href;
  void import(moduleUrl)
    .then(async (moduleNamespace: unknown) => {
      console.log(`Loaded main bridge module: ${modulePath}`);

      const maybeRecord = moduleNamespace as Record<string, unknown>;
      const runMainAppStartup =
        (typeof maybeRecord.runMainAppStartup === "function"
          ? maybeRecord.runMainAppStartup
          : undefined) ??
        (typeof (maybeRecord.default as Record<string, unknown> | undefined)
          ?.runMainAppStartup === "function"
          ? ((maybeRecord.default as Record<string, unknown>)
              .runMainAppStartup as (...args: unknown[]) => unknown)
          : undefined);

      if (!runMainAppStartup) {
        console.warn(
          "Main bridge module does not export runMainAppStartup; skipped startup call.",
        );
        return;
      }

      console.log("Invoking runMainAppStartup from main bridge module...");
      await Promise.resolve(runMainAppStartup());
      console.log("runMainAppStartup completed.");
    })
    .catch((error: unknown) => {
      console.error(`Failed to load main bridge module: ${modulePath}`);
      console.error(error);
    });
}

function main(args: string[]): void {
  const options = parseArgs(args);
  if (!process.env.ELECTRON_RENDERER_URL) {
    const trustedHost = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
    process.env.ELECTRON_RENDERER_URL = `http://${trustedHost}:${options.port}`;
  }

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
  const mainBridgeStat = statIfExists(MAIN_BRIDGE_PATH);
  if (!mainBridgeStat?.isFile()) {
    throw new Error(
      `Main bridge module not found: ${MAIN_BRIDGE_PATH}. Run 'yarn build:main-bridge' first.`,
    );
  }

  const server = http.createServer(createHandler(options));
  createIpcBridgeServer(server);
  server.listen(options.port, options.host, () => {
    console.log(`Serving: ${options.rootDir}`);
    console.log(`URL: http://${options.host}:${options.port}`);
    console.log(`Main bridge ready: ${MAIN_BRIDGE_PATH}`);
    loadMainBridgeModule(MAIN_BRIDGE_PATH);
  });
}

main(process.argv.slice(2));

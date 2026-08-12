#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";
import {
  MAX_MESSAGE_PORTS_PER_SOCKET,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  canonicalizeRoots,
  configuredRoots,
  createBrowserRequestPolicy,
  isLoopbackHost,
  parseRendererToMainMessage,
  resolveAllowedDirectory,
  resolveAllowedFile,
  validateBrowserRequest,
  validateRequestHost,
} from "./security";

type ServerOptions = {
  host: string;
  port: number;
};

const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_STORAGE_BYTES = 512 * 1024 * 1024;
const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1_000;

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
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

type MessagePortListener = (...args: unknown[]) => void;

type BridgedMessagePort = {
  close: () => void;
  on: (event: string, listener: MessagePortListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};

class WebSocketMessagePort implements BridgedMessagePort {
  private closed = false;
  private readonly listeners = new Map<string, Set<MessagePortListener>>();

  constructor(
    private readonly portId: string,
    private readonly sendToRenderer: (message: MainToRendererMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  on(event: string, listener: MessagePortListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);

    return this;
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-message",
      portId: this.portId,
      data,
    });
  }

  start(): void {}

  close(): void {
    if (!this.markClosed()) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-close",
      portId: this.portId,
    });
  }

  receiveMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    const listeners = this.listeners.get("message");
    if (!listeners || listeners.size === 0) {
      return;
    }
    for (const listener of listeners) {
      listener({ data });
    }
  }

  disconnect(): void {
    if (!this.markClosed()) {
      return;
    }
    this.emit("close");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private markClosed(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.onClosed();
    return true;
  }
}

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  handleRendererInvoke?: (channel: string, args: unknown[]) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    sourceUrl?: string,
    connectionId?: string,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ) => void;
  removeRendererConnection?: (connectionId: string) => void;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
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

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  const host = parsed.values.host ?? "127.0.0.1";
  if (
    !isLoopbackHost(host) &&
    process.env.CODEX_WEB_ALLOW_NON_LOOPBACK !== "1"
  ) {
    throw new Error(
      "Refusing a non-loopback listener. Use a local tunnel or set CODEX_WEB_ALLOW_NON_LOOPBACK=1 to acknowledge the risk.",
    );
  }

  return {
    host,
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
  };
}

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
    return error.message;
  }
  return String(error);
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
  workspaceRoots,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
  workspaceRoots: readonly string[];
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || workspaceRoots[0];
  if (!requestedPath) {
    throw new Error("No workspace roots are configured");
  }
  const resolvedPath = await resolveAllowedDirectory(
    requestedPath,
    workspaceRoots,
  );
  if (!resolvedPath) {
    throw new Error(`Directory is outside the configured workspace roots`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const parentPath = workspaceRoots.includes(resolvedPath)
    ? null
    : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
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
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });
  const sockets = new Set<WebSocket>();
  const requestPolicy = createBrowserRequestPolicy({
    configuredOrigins: process.env.CODEX_WEB_ALLOWED_ORIGINS,
    port: options.port,
  });
  const workspaceRoots = await canonicalizeRoots(
    configuredRoots(process.env.CODEX_WEB_WORKSPACE_ROOTS, [process.cwd()]),
  );
  const configuredFileRoots = await canonicalizeRoots(
    configuredRoots(process.env.CODEX_WEB_FILE_ROOTS, workspaceRoots),
  );

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );
  const fileRoots = [...configuredFileRoots, await fs.realpath(uploadRoot)];
  const storedUploads = new Map<string, { expiresAt: number; size: number }>();
  let storedUploadBytes = 0;
  let reservedUploadBytes = 0;

  const removeUpload = async (uploadedPath: string): Promise<void> => {
    const stored = storedUploads.get(uploadedPath);
    storedUploads.delete(uploadedPath);
    if (stored) {
      storedUploadBytes -= stored.size;
    }
    await fs.rm(uploadedPath, { force: true });
  };

  const cleanupExpiredUploads = async (): Promise<void> => {
    const now = Date.now();
    await Promise.all(
      [...storedUploads.entries()]
        .filter(([, stored]) => stored.expiresAt <= now)
        .map(([uploadedPath]) => removeUpload(uploadedPath)),
    );
  };
  const uploadCleanupInterval = setInterval(
    () => void cleanupExpiredUploads(),
    60 * 60 * 1_000,
  );
  uploadCleanupInterval.unref();

  app.addHook("onClose", async () => {
    clearInterval(uploadCleanupInterval);
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_UPLOAD_FILE_BYTES,
      files: MAX_UPLOAD_FILES,
      parts: MAX_UPLOAD_FILES,
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!validateRequestHost(request.headers.host, requestPolicy)) {
      return reply.code(403).send({ error: "Host is not allowed" });
    }
  });

  app.post("/__backend/upload", async (request, reply) => {
    const requestValidation = validateBrowserRequest(
      { host: request.headers.host, origin: request.headers.origin },
      requestPolicy,
    );
    if (!requestValidation.ok) {
      return reply.code(403).send({ error: requestValidation.error });
    }
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const uploadedThisRequest: string[] = [];
    try {
      const files = await Array.fromAsync(
        (async function* () {
          for await (const part of request.files()) {
            if (
              storedUploadBytes + reservedUploadBytes + MAX_UPLOAD_FILE_BYTES >
              MAX_UPLOAD_STORAGE_BYTES
            ) {
              throw new Error("upload storage quota exceeded");
            }
            reservedUploadBytes += MAX_UPLOAD_FILE_BYTES;
            const label = (part.filename?.trim() || "upload").slice(0, 255);

            const uploadedPath = path.join(uploadRoot, randomUUID());
            try {
              await pipeline(
                part.file,
                createWriteStream(uploadedPath, { flags: "wx" }),
              );
              if (part.file.truncated) {
                throw new Error("upload file size limit exceeded");
              }
              const stat = await fs.stat(uploadedPath);
              storedUploadBytes += stat.size;
              storedUploads.set(uploadedPath, {
                expiresAt: Date.now() + UPLOAD_LIFETIME_MS,
                size: stat.size,
              });
              uploadedThisRequest.push(uploadedPath);
            } catch (error) {
              await fs.rm(uploadedPath, { force: true });
              throw error;
            } finally {
              reservedUploadBytes -= MAX_UPLOAD_FILE_BYTES;
            }

            yield {
              label,
              path: uploadedPath,
              fsPath: uploadedPath,
            };
          }
        })(),
      );

      return reply.send({ files });
    } catch (error) {
      await Promise.all(uploadedThisRequest.map(removeUpload));
      const message = errorMessage(error);
      const statusCode =
        message.includes("limit") || message.includes("quota") ? 413 : 500;
      return reply.code(statusCode).send({ error: message });
    }
  });

  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../../scratch/asar/webview"),
    prefix: "/",
  });

  app.get("/@fs/*", async (request, reply) => {
    const requestedPath = (request.params as { "*": string })["*"];
    const allowedFile = await resolveAllowedFile(requestedPath, fileRoots);
    if (!allowedFile) {
      return reply.code(404).send({ error: "Not Found" });
    }
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.sendFile(allowedFile.relativePath, allowedFile.root, {
      cacheControl: false,
      lastModified: false,
    });
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const url = new URL(requestUrl, "http://localhost");
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }
    const requestValidation = validateBrowserRequest(
      { host: request.headers.host, origin: request.headers.origin },
      requestPolicy,
    );
    if (!requestValidation.ok) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  };

  websocketServer.on("connection", (socket, request) => {
    sockets.add(socket);
    const connectionId = randomUUID();
    const verifiedOrigin = request.headers.origin!;

    const messagePorts = new Map<string, WebSocketMessagePort>();
    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
      sourceUrl?: string,
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, sourceUrl, connectionId);
        return;
      }

      console.error(
        `[ipc-bridge] no ipcMain postMessage handler for channel ${channel}`,
      );
      for (const port of ports) {
        port.close();
      }
    };

    socket.on("close", () => {
      sockets.delete(socket);
      bridgeState.removeRendererConnection?.(connectionId);
      for (const port of messagePorts.values()) {
        port.disconnect();
      }
      messagePorts.clear();
    });

    socket.on("message", (rawData) => {
      const parsedMessage = parseRendererToMainMessage(String(rawData));
      if (!parsedMessage.ok) {
        console.error(`[ipc-bridge] ${parsedMessage.error}`);
        socket.close(1008, "Invalid IPC message");
        return;
      }
      const message = parsedMessage.value;

      try {
        if (message.type === "ipc-renderer-send") {
          bridgeState.handleRendererSend?.(
            message.channel,
            message.args,
            verifiedOrigin,
          );
          return;
        }

        if (message.type === "ipc-renderer-post-message") {
          const newPortCount = message.portIds.filter(
            (portId) => !messagePorts.has(portId),
          ).length;
          if (messagePorts.size + newPortCount > MAX_MESSAGE_PORTS_PER_SOCKET) {
            socket.close(1008, "Too many message ports");
            return;
          }

          const ports = message.portIds.map((portId) => {
            const existingPort = messagePorts.get(portId);
            if (existingPort) {
              existingPort.disconnect();
            }
            const port = new WebSocketMessagePort(
              portId,
              (message) => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify(message));
                }
              },
              () => messagePorts.delete(portId),
            );
            messagePorts.set(portId, port);
            return port;
          });

          dispatchPostMessage(
            message.channel,
            message.message,
            ports,
            verifiedOrigin,
          );
          return;
        }

        if (message.type === "message-port-message") {
          messagePorts.get(message.portId)?.receiveMessage(message.data);
          return;
        }

        if (message.type === "message-port-close") {
          messagePorts.get(message.portId)?.disconnect();
          return;
        }

        if (message.type === "workspace-directory-entries-request") {
          const { requestId } = message;
          getWorkspaceDirectoryEntries({ ...message, workspaceRoots })
            .then((result) => {
              const payload: MainToRendererMessage = {
                type: "workspace-directory-entries-result",
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
                type: "workspace-directory-entries-result",
                requestId,
                ok: false,
                errorMessage: errorMessage(error),
              };
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(payload));
              }
            });
          return;
        }

        if (message.type === "ipc-renderer-invoke") {
          const { channel, requestId, args } = message;
          Promise.resolve(
            bridgeState.handleRendererInvoke?.(channel, args) ??
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
      } catch (error) {
        console.error("[ipc-bridge] message handler failed", error);
        socket.close(1011, "IPC handler failed");
      }
    });
  });

  await app.listen({ host: options.host, port: options.port });
  console.log(`Codex Web listening at http://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../scratch/asar/package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
  };

  const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
    nodir: true,
    cwd: __dirname,
  });

  if (matches.length === 0) {
    throw new Error("no main bundle found");
  }

  if (matches.length > 1) {
    throw new Error("multiple main bundles found");
  }

  const module = require(matches[0]!);
  module.runMainAppStartup();
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));

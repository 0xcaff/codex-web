#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";

export type ServerOptions = {
  host: string;
  port: number;
  allowedOrigins: string[];
};

export const IPC_MAX_PAYLOAD_BYTES = 1024 * 1024;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl?: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl?: string;
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
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
  ) => void;
  handleRendererSend?: (channel: string, args: unknown[]) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

export function isRendererToMainMessage(
  value: unknown,
): value is RendererToMainMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "ipc-renderer-invoke":
      return (
        typeof value.requestId === "string" &&
        typeof value.channel === "string" &&
        Array.isArray(value.args) &&
        (value.sourceUrl === undefined || typeof value.sourceUrl === "string")
      );
    case "ipc-renderer-send":
      return (
        typeof value.channel === "string" &&
        Array.isArray(value.args) &&
        (value.sourceUrl === undefined || typeof value.sourceUrl === "string")
      );
    case "ipc-renderer-post-message":
      return (
        typeof value.channel === "string" &&
        isStringArray(value.portIds) &&
        new Set(value.portIds).size === value.portIds.length &&
        (value.sourceUrl === undefined || typeof value.sourceUrl === "string")
      );
    case "message-port-message":
      return typeof value.portId === "string";
    case "message-port-close":
      return typeof value.portId === "string";
    case "workspace-directory-entries-request":
      return (
        typeof value.requestId === "string" &&
        (value.directoryPath === null ||
          typeof value.directoryPath === "string") &&
        typeof value.directoriesOnly === "boolean"
      );
    default:
      return false;
  }
}

export function parseRendererToMainMessage(
  rawData: unknown,
  isBinary: boolean,
): RendererToMainMessage | null {
  if (
    isBinary ||
    !Buffer.isBuffer(rawData) ||
    rawData.length > IPC_MAX_PAYLOAD_BYTES
  ) {
    return null;
  }

  try {
    const message: unknown = JSON.parse(rawData.toString("utf8"));
    return isRendererToMainMessage(message) ? message : null;
  } catch {
    return null;
  }
}

function closeWithProtocolError(socket: WebSocket, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1002, reason);
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>] [--allowed-origin <origin>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "  --allowed-origin may be repeated to allow an exact HTTP(S) reverse-proxy origin",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
    ].join("\n"),
  );
}

export function normalizeHttpOrigin(value: string): string | null {
  if (!value || value !== value.trim()) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hostname.startsWith("*.") ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeRequestHost(value: string | undefined): string | null {
  if (!value || value !== value.trim() || /[/?#@]|:\/\//.test(value)) {
    return null;
  }

  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== "/" || !url.hostname) {
      return null;
    }
    return url.host;
  } catch {
    return null;
  }
}

export function isAllowedIpcOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (typeof originHeader !== "string") {
    return false;
  }

  const origin = normalizeHttpOrigin(originHeader);
  const host = normalizeRequestHost(hostHeader);
  if (!origin || !host) {
    return false;
  }

  return new URL(origin).host === host || allowedOrigins.includes(origin);
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

export function parseServerArgs(args: string[]): ServerOptions {
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
      "allowed-origin": {
        type: "string",
        multiple: true,
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  const rawAllowedOrigins = parsed.values["allowed-origin"] ?? [];
  const allowedOrigins = rawAllowedOrigins.map((origin) => {
    const normalized = normalizeHttpOrigin(origin);
    if (!normalized) {
      throw new Error(
        `Invalid --allowed-origin (must be an exact HTTP(S) origin): ${origin}`,
      );
    }
    return normalized;
  });

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
    allowedOrigins,
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
    return error.stack ?? error.message;
  }
  return String(error);
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
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

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

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

export async function startIpcBridgeServer(
  options: ServerOptions,
  {
    startMainApp = true,
    webviewRoot = path.resolve(__dirname, "../../scratch/asar/webview"),
  }: { startMainApp?: boolean; webviewRoot?: string } = {},
): Promise<{ close: () => Promise<void>; port: number }> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: IPC_MAX_PAYLOAD_BYTES,
  });
  const sockets = new Set<WebSocket>();

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Infinity,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: webviewRoot,
    prefix: "/",
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
    const host = request.headers.host ?? "localhost";
    let url: URL;
    try {
      url = new URL(requestUrl, `http://${host}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    if (
      !isAllowedIpcOrigin(
        request.headers.origin,
        request.headers.host,
        options.allowedOrigins,
      )
    ) {
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

  websocketServer.on("connection", (socket) => {
    sockets.add(socket);

    const messagePorts = new Map<string, WebSocketMessagePort>();
    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
      sourceUrl?: string,
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, sourceUrl);
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
      for (const port of messagePorts.values()) {
        port.disconnect();
      }
      messagePorts.clear();
    });

    socket.on("error", (error) => {
      console.error("[ipc-bridge] websocket error", error);
    });

    socket.on("message", (rawData, isBinary) => {
      const message = parseRendererToMainMessage(rawData, isBinary);
      if (!message) {
        closeWithProtocolError(socket, "Invalid IPC message");
        return;
      }

      try {
        if (message.type === "ipc-renderer-send") {
          bridgeState.handleRendererSend?.(message.channel, message.args);
          return;
        }

        if (message.type === "ipc-renderer-post-message") {
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
            message.sourceUrl,
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
          getWorkspaceDirectoryEntries(message)
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
        console.error("[ipc-bridge] failed to handle IPC message", error);
        closeWithProtocolError(socket, "IPC message handling failed");
      }
    });
  });

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("IPC bridge did not bind a TCP port");
  }

  if (!startMainApp) {
    return {
      close: async () => {
        for (const socket of sockets) {
          socket.terminate();
        }
        websocketServer.close();
        await app.close();
      },
      port: address.port,
    };
  }

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

  return {
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      websocketServer.close();
      await app.close();
    },
    port: address.port,
  };
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

if (require.main === module) {
  void main(process.argv.slice(2));
}

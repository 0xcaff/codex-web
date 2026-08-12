#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import {
  DEFAULT_UPLOAD_LIMITS,
  createUploadDirectory,
  receiveUploadFiles,
  scavengeExpiredUploads,
  UploadError,
} from "./uploads";
import { setStaticAssetHeaders } from "./static-assets";
import {
  getServerStartupReport,
  isAllowedIpcOrigin,
  parseServerArgs,
  type ServerOptions,
} from "./config";
import { bootstrapMainApp } from "./bootstrap";
import { ControllerLeaseManager, isSafeReadOnlyIpc } from "./controller-lease";
import {
  IPC_MAX_PAYLOAD_BYTES,
  parseRendererToMainMessage as parseWireRendererToMainMessage,
  serializeMainToRendererMessage,
  type MainToRendererMessage,
  type RendererToMainMessage,
  type WorkspaceDirectoryEntries,
  type WorkspaceDirectoryEntry,
} from "../shared/ipc-protocol";

export {
  formatHttpUrl,
  getServerStartupReport,
  getTrustedNetworkUrls,
  isAllowedIpcOrigin,
  normalizeHttpOrigin,
  normalizeRequestHost,
  parseServerArgs,
  type ServerOptions,
} from "./config";
export { bootstrapMainApp } from "./bootstrap";

export {
  IPC_MAX_MAIN_TO_RENDERER_PAYLOAD_BYTES,
  IPC_MAX_PAYLOAD_BYTES,
} from "../shared/ipc-protocol";

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
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    sourceUrl?: string,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
  ) => void;
};

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
    return parseWireRendererToMainMessage(message);
  } catch {
    return null;
  }
}

function closeWithProtocolError(socket: WebSocket, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1002, reason);
  }
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

export async function startIpcBridgeServer(
  options: ServerOptions,
  {
    startMainApp = true,
    bootstrapMainApp: bootstrap = bootstrapMainApp,
    webviewRoot = path.resolve(__dirname, "../../scratch/asar/webview"),
  }: {
    startMainApp?: boolean;
    bootstrapMainApp?: () => Promise<void> | void;
    webviewRoot?: string;
  } = {},
): Promise<{ close: () => Promise<void>; port: number }> {
  const bridgeState = getIpcMainBridgeState();
  const uploadLimits = options.uploadLimits ?? DEFAULT_UPLOAD_LIMITS;
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: IPC_MAX_PAYLOAD_BYTES,
  });
  const sockets = new Set<WebSocket>();
  const controllerLease = new ControllerLeaseManager();
  const socketClientIds = new Map<WebSocket, string>();

  await app.register(fastifyMultipart, {
    throwFileSizeLimit: true,
    limits: {
      fields: 0,
      fileSize: uploadLimits.maxFileBytes,
      files: uploadLimits.maxFiles,
      parts: uploadLimits.maxFiles,
    },
  });

  // Scavenging only recognizes our marker and exact generated names. It is
  // deliberately best-effort: a manual file or a symlink makes that directory
  // ineligible rather than something to recursively remove.
  await scavengeExpiredUploads({ retentionMs: uploadLimits.retentionMs });
  const uploadRoot = await createUploadDirectory();

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    try {
      return reply.send({
        files: await receiveUploadFiles({
          request,
          limits: uploadLimits,
          uploadDirectory: uploadRoot,
        }),
      });
    } catch (error) {
      if (error instanceof UploadError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: webviewRoot,
    prefix: "/",
    preCompressed: true,
    setHeaders: setStaticAssetHeaders,
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
    let payload: string;
    try {
      payload = serializeMainToRendererMessage(message);
    } catch (error) {
      console.error("[ipc-bridge] refused invalid renderer message", error);
      return;
    }
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  };

  const publishControllerStatuses = (): void => {
    for (const [connectedSocket, connectedClientId] of socketClientIds) {
      if (connectedSocket.readyState === WebSocket.OPEN) {
        connectedSocket.send(
          serializeMainToRendererMessage({
            type: "controller-status",
            status: controllerLease.statusFor(connectedClientId),
          }),
        );
      }
    }
  };

  websocketServer.on("connection", (socket) => {
    sockets.add(socket);
    let clientId: string | null = null;

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
      if (clientId) {
        socketClientIds.delete(socket);
        controllerLease.disconnect(clientId);
        publishControllerStatuses();
      }
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
        if (
          message.type === "controller-connect" ||
          message.type === "controller-heartbeat" ||
          message.type === "controller-take-control"
        ) {
          if (clientId && clientId !== message.clientId) {
            closeWithProtocolError(socket, "Controller identity changed");
            return;
          }
          clientId = message.clientId;
          socketClientIds.set(socket, clientId);
          if (message.type === "controller-connect")
            controllerLease.connect(clientId);
          if (message.type === "controller-heartbeat")
            controllerLease.heartbeat(clientId);
          if (message.type === "controller-take-control")
            controllerLease.takeControl(clientId);
          publishControllerStatuses();
          return;
        }

        if (!clientId) {
          closeWithProtocolError(socket, "Controller identity required");
          return;
        }

        if (
          !isSafeReadOnlyIpc(message) &&
          !controllerLease.canMutate(clientId)
        ) {
          if (message.type === "ipc-renderer-invoke") {
            socket.send(
              serializeMainToRendererMessage({
                type: "ipc-renderer-invoke-result",
                requestId: message.requestId,
                ok: false,
                errorMessage: "Controller lease required for this operation",
              }),
            );
          }
          return;
        }

        if (message.type === "ipc-renderer-send") {
          const handler = bridgeState.handleRendererSend;
          if (!handler) {
            closeWithProtocolError(socket, "IPC bridge unavailable");
            return;
          }
          handler(message.channel, message.args, message.sourceUrl);
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
                  socket.send(serializeMainToRendererMessage(message));
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
                socket.send(serializeMainToRendererMessage(payload));
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
                socket.send(serializeMainToRendererMessage(payload));
              }
            });
          return;
        }

        if (message.type === "ipc-renderer-invoke") {
          const { channel, requestId, args } = message;
          Promise.resolve(
            bridgeState.handleRendererInvoke?.(
              channel,
              args,
              message.sourceUrl,
            ) ??
              Promise.reject(
                new Error(
                  `[ipc-bridge] unavailable: no ipcMain.handle for channel ${channel}`,
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
                socket.send(serializeMainToRendererMessage(payload));
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
                socket.send(serializeMainToRendererMessage(payload));
              }
            });
        }
      } catch (error) {
        console.error("[ipc-bridge] failed to handle IPC message", error);
        closeWithProtocolError(socket, "IPC message handling failed");
      }
    });
  });

  if (startMainApp) {
    // Startup may return the upstream application's lifecycle promise. Bind
    // HTTP immediately and use handler presence below as the IPC readiness
    // signal instead of blocking on a promise that normally never resolves.
    try {
      void Promise.resolve(bootstrap()).catch((error) => {
        console.error("[ipc-bridge] startup failed", error);
      });
    } catch (error) {
      console.error("[ipc-bridge] startup failed", error);
    }
  }

  await app.listen({ host: options.host, port: options.port });

  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("IPC bridge did not bind a TCP port");
  }

  for (const line of getServerStartupReport(options, address.port)) {
    console.log(line);
  }

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
  const bridge = await startIpcBridgeServer(options);
  let closing = false;
  const closeGracefully = (signal: NodeJS.Signals): void => {
    if (closing) {
      return;
    }
    closing = true;
    void bridge.close().catch((error: unknown) => {
      console.error(`[ipc-bridge] failed graceful ${signal} shutdown`, error);
    });
  };
  process.once("SIGINT", () => closeGracefully("SIGINT"));
  process.once("SIGTERM", () => closeGracefully("SIGTERM"));
}

if (require.main === module) {
  void main(process.argv.slice(2));
}

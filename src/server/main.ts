#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { execFileSync } from "node:child_process";
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
import { serialize, deserialize } from "@ungap/structured-clone";
import {
  MessagePortBridge,
  type MessagePortMain,
} from "./electron/message-port";

type ServerOptions = {
  host: string;
  port: number;
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
      data: ReturnType<typeof serialize>;
      portIds: string[];
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
      type: "ipc-main-post-message";
      channel: string;
      message: ReturnType<typeof serialize>;
      portIds: string[];
    }
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
      data: ReturnType<typeof serialize>;
      portIds: string[];
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

type BridgedMessagePort = MessagePortMain;

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

type RendererWindow = {
  id: number;
  webContents: { id: number };
  destroy: () => void;
  isDestroyed: () => boolean;
  once: (event: string, listener: MessagePortListener) => unknown;
};

type IpcMainBridgeState = {
  postToRenderer?: (
    webContentsId: number,
    channel: string,
    message: unknown,
    ports: MessagePortMain[],
  ) => void;
  setRendererWindowFactory?: (factory: () => Promise<RendererWindow>) => void;
  sendToRenderer?: (
    webContentsId: number,
    message: MainToRendererMessage,
  ) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    windowId: number,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => void;
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

  return {
    host: parsed.values.host ?? "127.0.0.1",
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
  process.env.BUILD_FLAVOR = "prod";

  const versions = process.versions as NodeJS.ProcessVersions & {
    chrome?: string;
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
  if (!versions.chrome) {
    // Upstream uses the bundled Chromium version for HTTP client hints.
    Object.defineProperty(versions, "chrome", {
      value: "157.0.8103.39",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    getSystemVersion?: () => string;
    resourcesPath?: string;
    type?: string;
  };
  const systemVersion =
    process.platform === "darwin"
      ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
        }).trim()
      : os.release();
  processWithElectronFields.getSystemVersion ??= () => systemVersion;
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({ noServer: true });

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
    root: path.resolve(__dirname, "../../scratch/asar/webview"),
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
    const url = new URL(requestUrl, `http://${host}`);
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  const rendererSockets = new Map<number, WebSocket>();
  const rendererPorts = new Map<number, MessagePortBridge>();
  const rendererWindowFactory = new Promise<() => Promise<RendererWindow>>(
    (resolve) => {
      bridgeState.setRendererWindowFactory = resolve;
    },
  );
  bridgeState.sendToRenderer = (webContentsId, message): void => {
    const socket = rendererSockets.get(webContentsId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  bridgeState.postToRenderer = (
    webContentsId,
    channel,
    message,
    ports,
  ): void => {
    const bridge = rendererPorts.get(webContentsId);
    if (!bridge) {
      for (const port of ports) port.close();
      return;
    }
    bridgeState.sendToRenderer?.(webContentsId, {
      type: "ipc-main-post-message",
      channel,
      message: serialize(message),
      portIds: bridge.exportPorts(ports),
    });
  };

  websocketServer.on("connection", (socket) => {
    const portBridge = new MessagePortBridge((packet) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify(
            packet.type === "message-port-message"
              ? { ...packet, data: serialize(packet.data) }
              : packet,
          ),
        );
      }
    });
    let rendererWindow: RendererWindow | undefined;
    // Each tab is a real registered app view, with its own IPC client and ownership.
    const rendererReady = rendererWindowFactory
      .then(async (createWindow) => {
        if (socket.readyState !== WebSocket.OPEN) return undefined;
        const window = await createWindow();
        if (socket.readyState !== WebSocket.OPEN || window.isDestroyed()) {
          window.destroy();
          socket.close(1012, "Renderer window closed");
          return undefined;
        }
        rendererWindow = window;
        // Workspace changes can close an app view while its browser is connected.
        // Let the browser reconnect instead of dispatching IPC to a dead window.
        window.once("closed", () =>
          socket.close(1012, "Renderer window closed"),
        );
        rendererSockets.set(window.webContents.id, socket);
        rendererPorts.set(window.webContents.id, portBridge);
        return window;
      })
      .catch((error) => {
        console.error("[ipc-bridge] failed to create renderer window", error);
        socket.close(1011, "Renderer initialization failed");
        return undefined;
      });

    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: MessagePortMain[],
      windowId: number,
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, windowId);
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
      portBridge.close();
      if (rendererWindow) {
        rendererSockets.delete(rendererWindow.webContents.id);
        rendererPorts.delete(rendererWindow.webContents.id);
        rendererWindow.destroy();
      }
    });

    socket.on("message", async (rawData) => {
      const window = await rendererReady;
      if (!window || socket.readyState !== WebSocket.OPEN) return;
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
          window.id,
        );
        return;
      }

      if (
        message.type === "ipc-renderer-post-message" ||
        message.type === "message-port-message" ||
        message.type === "message-port-close"
      ) {
        try {
          if (message.type === "ipc-renderer-post-message") {
            const ports = portBridge.importPorts(message.portIds);
            dispatchPostMessage(
              message.channel,
              message.message,
              ports,
              window.id,
            );
          } else if (message.type === "message-port-message") {
            portBridge.receive({ ...message, data: deserialize(message.data) });
          } else {
            portBridge.receive(message);
          }
        } catch (error) {
          console.error("[ipc-bridge] invalid MessagePort payload", error);
          socket.close(1003, "Invalid MessagePort payload");
        }
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
          bridgeState.handleRendererInvoke?.(channel, args, window.id) ??
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

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

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

  // The upstream entrypoint initializes network policy and starts the app once.
  require(path.resolve(__dirname, "../../scratch/asar", packageJson.main));
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));

#!/usr/bin/env node

import Module from "node:module";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";

type ServerOptions = {
  host: string;
  port: number;
  rendererUrl: string;
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

const IPC_BRIDGE_PATH = "/__electron_ipc";

const DEFAULT_RENDERER_URL = "http://127.0.0.1:4173";

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>] [--renderer-url <url>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      `  --renderer-url ${DEFAULT_RENDERER_URL}`,
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
      "  yarn server --renderer-url http://127.0.0.1:4173",
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
      "renderer-url": {
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
    rendererUrl:
      parsed.values["renderer-url"] ??
      process.env.ELECTRON_RENDERER_URL ??
      DEFAULT_RENDERER_URL,
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
  processWithElectronFields.resourcesPath ??= path.resolve(__dirname, "../../scratch/asar");
  processWithElectronFields.type ??= "browser";
}

let moduleAliasHookInstalled = false;

function installModuleAliasHook(): void {
  if (moduleAliasHookInstalled) {
    return;
  }

  const moduleWithLoad = Module as typeof Module & {
    _load: (
      request: string,
      parent: NodeModule | undefined,
      isMain: boolean,
    ) => unknown;
  };
  const originalLoad = moduleWithLoad._load;

  moduleWithLoad._load = function moduleAliasLoad(
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
  ): unknown {
    if (request === "electron") {
      return originalLoad.call(this, path.resolve(
        path.resolve(__dirname, "../.."),
        "src/server/electron/index.js",
      ), parent, isMain);
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  moduleAliasHookInstalled = true;
}

function loadMainBridgeModule(): void {
  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  void Promise.resolve()
    .then(() => require(path.resolve(__dirname, "../../scratch/asar/.vite/build/main-1fsOo4Rt.js")) as unknown)
    .then(async (moduleNamespace: unknown) => {
      console.log(`Loaded main bridge module: ${(path.resolve(__dirname, "../../scratch/asar/.vite/build/main-1fsOo4Rt.js"))}`);

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
      console.error(`Failed to load main bridge module: ${(path.resolve(__dirname, "../../scratch/asar/.vite/build/main-1fsOo4Rt.js"))}`);
      console.error(error);
    });
}

function startIpcBridgeServer(
  options: ServerOptions,
): void {
  const bridgeState = getIpcMainBridgeState();
  const websocketServer = new WebSocketServer({
    host: options.host,
    port: options.port,
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

  websocketServer.on("listening", () => {
    console.log(
      `IPC bridge listening at ws://${options.host}:${options.port}${IPC_BRIDGE_PATH}`,
    );
    loadMainBridgeModule();
  });
}

function main(args: string[]): void {
  const options = parseServerArgs(args);
  process.env.ELECTRON_RENDERER_URL ??= options.rendererUrl;

  startIpcBridgeServer(options);
}

main(process.argv.slice(2));

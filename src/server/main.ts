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
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";

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
  private readonly pendingMessages: unknown[] = [];
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
    if (event === "message") {
      for (const data of this.pendingMessages.splice(0)) {
        this.receiveMessage(data);
      }
    }

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
      this.pendingMessages.push(data);
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
    this.pendingMessages.length = 0;
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

type RendererWindow = {
  id: number;
  webContents: { id: number };
  destroy: () => void;
};

type IpcMainBridgeState = {
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

  websocketServer.on("connection", (socket) => {
    let rendererWindow: RendererWindow | undefined;
    // Each tab is a real registered app view, with its own IPC client and ownership.
    const rendererReady = rendererWindowFactory
      .then(async (createWindow) => {
        if (socket.readyState !== WebSocket.OPEN) return undefined;
        const window = await createWindow();
        if (socket.readyState !== WebSocket.OPEN) {
          window.destroy();
          return undefined;
        }
        rendererWindow = window;
        rendererSockets.set(window.webContents.id, socket);
        return window;
      })
      .catch((error) => {
        console.error("[ipc-bridge] failed to create renderer window", error);
        socket.close(1011, "Renderer initialization failed");
        return undefined;
      });

    const messagePorts = new Map<string, WebSocketMessagePort>();
    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
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
      for (const port of messagePorts.values()) {
        port.disconnect();
      }
      messagePorts.clear();
      if (rendererWindow) {
        rendererSockets.delete(rendererWindow.webContents.id);
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

      if (message.type === "ipc-renderer-post-message") {
        if (new Set(message.portIds).size !== message.portIds.length) {
          console.error("[ipc-bridge] duplicate transferred MessagePort id");
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

        dispatchPostMessage(message.channel, message.message, ports, window.id);
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

  await reconcileSidebarCatalogWithThreadDatabases();

  const module = require(matches[0]!);
  module.runMainAppStartup();
}

async function reconcileSidebarCatalogWithThreadDatabases(): Promise<void> {
  // The shell keeps a discovery cache of threads in
  // <CODEX_HOME>/sqlite/codex.db (`local_thread_catalog`) and only mutates it
  // from events of the app-server it is connected to: entries appear when the
  // shell observes a thread start, and disappear on `thread/archived`.
  // Threads created by another app-server -- `codex` or `codex exec` from a
  // terminal -- never show up in the sidebar at all, and sessions archived
  // that way stay listed under Recents forever. Neither is reconciled, not
  // even across restarts.
  //
  // Before the shell opens the database, reconcile the catalog against the
  // app-server's own thread databases: drop rows whose thread is archived
  // there, and insert rows for threads the catalog has never seen. Bump the
  // catalog revision afterwards so the shell refreshes its in-memory
  // snapshot.
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const catalogPath = path.join(codexHome, "sqlite", "codex.db");

  let catalog: DatabaseSync;
  try {
    catalog = new DatabaseSync(catalogPath);
  } catch {
    return;
  }

  try {
    const catalogRows = catalog
      .prepare("select host_id, thread_id, source_kind from local_thread_catalog")
      .all() as { host_id: string; thread_id: string; source_kind: string }[];

    type ThreadRow = {
      id: string;
      source: string | null;
      thread_source: string | null;
      name: string | null;
      title: string | null;
      cwd: string | null;
      model_provider: string | null;
      git_branch: string | null;
      created_at_ms: number | null;
      updated_at_ms: number | null;
      recency_at_ms: number | null;
      archived: number;
    };
    const threads: ThreadRow[] = [];
    const stateNames = (await fs.readdir(codexHome)).filter((name) =>
      /^state_\d+\.sqlite$/.test(name),
    );
    for (const name of stateNames) {
      let state: DatabaseSync | null = null;
      try {
        // Not readOnly: these databases run in WAL mode, which needs write
        // access to the -shm sidecar even for pure readers.
        state = new DatabaseSync(path.join(codexHome, name));
        const hasThreads = state
          .prepare(
            "select 1 from sqlite_master where type = 'table' and name = 'threads'",
          )
          .get();
        if (hasThreads) {
          threads.push(
            ...(state
              .prepare(
                `select id, source, thread_source, name, title, cwd,
                        model_provider, git_branch, created_at_ms,
                        updated_at_ms, recency_at_ms, archived
                   from threads`,
              )
              .all() as ThreadRow[]),
          );
        }
      } catch {
        // Unreadable state database: skip it rather than guess.
      } finally {
        state?.close();
      }
    }

    const sourceKinds = new Set([
      "cli",
      "vscode",
      "exec",
      "appServer",
      "chatgpt",
      "custom",
      "unknown",
    ]);
    const archived = new Set(
      threads.filter((row) => row.archived === 1).map((row) => row.id),
    );
    const allIds = new Set(threads.map((row) => row.id));
    const known = new Set(catalogRows.map((row) => row.thread_id));
    const seconds = (ms: number | null): number =>
      ms == null ? 0 : ms / 1000;

    // Threads archived elsewhere, and threads that no longer exist at all
    // (`codex delete` from a terminal), both leave ghost rows behind. Cloud
    // ("chatgpt") threads live outside the local state databases, so the
    // existence check must not apply to them.
    const stale = catalogRows.filter(
      (row) =>
        archived.has(row.thread_id) ||
        (row.source_kind !== "chatgpt" && !allIds.has(row.thread_id)),
    );
    const missing = threads.filter(
      (row) => row.archived === 0 && !known.has(row.id),
    );
    if (stale.length === 0 && missing.length === 0) {
      return;
    }

    const remove = catalog.prepare(
      "delete from local_thread_catalog where host_id = ? and thread_id = ?",
    );
    const insert = catalog.prepare(
      `insert into local_thread_catalog (
         host_id, thread_id, display_title, source_created_at,
         source_updated_at, source_recency_at, cwd, source_kind,
         source_detail, thread_source, model_provider, git_branch,
         observation_sequence, missing_candidate, pending_observed_title,
         project_id, conversation_origin
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, null, null)
       on conflict (host_id, thread_id) do nothing`,
    );
    const bumpRevision = catalog.prepare(
      "update local_thread_catalog_metadata set catalog_revision = catalog_revision + 1",
    );

    catalog.exec("begin");
    try {
      for (const row of stale) {
        remove.run(row.host_id, row.thread_id);
      }
      for (const row of missing) {
        const title =
          row.name?.trim() || row.title?.trim() || row.id;
        insert.run(
          "local",
          row.id,
          title,
          seconds(row.created_at_ms),
          seconds(row.updated_at_ms),
          seconds(row.recency_at_ms ?? row.updated_at_ms),
          row.cwd,
          row.source != null && sourceKinds.has(row.source) ? row.source : "cli",
          null,
          row.thread_source,
          row.model_provider,
          row.git_branch,
          1,
        );
      }
      bumpRevision.run();
      catalog.exec("commit");
    } catch (error) {
      catalog.exec("rollback");
      throw error;
    }
    console.log(
      `[codex-web] sidebar catalog reconciled: dropped ${stale.length} stale, added ${missing.length} missing thread(s)`,
    );
  } catch (error) {
    console.warn("[codex-web] sidebar catalog reconcile skipped:", error);
  } finally {
    catalog.close();
  }
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));

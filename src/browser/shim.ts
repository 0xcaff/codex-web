import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import { openSelectWorkspaceRootDialog } from "./workspace-root-dialog";
import {
  IPC_MAX_PAYLOAD_BYTES,
  parseMainToRendererMessage,
  serializeRendererToMainMessage,
  type MainToRendererMessage,
  type RendererToMainMessage,
  type WorkspaceDirectoryEntries,
} from "../shared/ipc-protocol";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

const RECONNECT_DELAY_MS = 1_000;
const MAX_PENDING_REQUESTS = 128;
const MAX_OUTBOUND_QUEUE_MESSAGES = 128;
const MAX_OUTBOUND_QUEUE_BYTES = 256 * 1024;
const CONTROLLER_HEARTBEAT_MS = 5_000;
const CONTROLLER_STORAGE_KEY = "codex-web-controller-client-id";

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;
declare const __ELECTRON_EMULATION_VERSION__: string;

type PendingInvoke = {
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
};

type PendingDirectoryEntries = {
  reject: (reason?: unknown) => void;
  resolve: (value: WorkspaceDirectoryEntries) => void;
};

type BridgeWebSocket = {
  readyState: number;
  addEventListener: (
    event: "close" | "error" | "message" | "open",
    listener: (event: { data?: unknown }) => void,
  ) => void;
  send: (data: string) => void;
};

type QueuedMessage = {
  payload: string;
  payloadBytes: number;
};

export class IpcBridgeDisconnectedError extends Error {
  readonly code = "IPC_BRIDGE_DISCONNECTED";
  readonly retryable = true;

  constructor() {
    super("The IPC bridge disconnected before the request completed.");
    this.name = "IpcBridgeDisconnectedError";
  }
}

export class IpcBridgeCapacityError extends Error {
  readonly code = "IPC_BRIDGE_CAPACITY";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "IpcBridgeCapacityError";
  }
}

export class IpcBridgeTransport {
  private requestCounter = 0;
  private socket: BridgeWebSocket | null = null;
  private reconnectTimeoutId: number | null = null;
  private outboundQueue: QueuedMessage[] = [];
  private outboundQueueBytes = 0;
  private readonly pendingInvokes = new Map<string, PendingInvoke>();
  private readonly pendingDirectoryEntries = new Map<
    string,
    PendingDirectoryEntries
  >();
  private readonly clientId: string;

  constructor(
    private readonly url: string,
    private readonly createSocket: (url: string) => BridgeWebSocket,
    private readonly handleIncoming: (message: MainToRendererMessage) => void,
    private readonly handleDisconnect: () => void,
    private readonly setReconnectTimeout: (
      callback: () => void,
      delay: number,
    ) => number = window.setTimeout.bind(window),
    clientId = getStableControllerClientId(),
  ) {
    this.clientId = clientId;
  }

  get pendingRequestCount(): number {
    return this.pendingInvokes.size + this.pendingDirectoryEntries.size;
  }

  get queuedMessageCount(): number {
    return this.outboundQueue.length;
  }

  get queuedByteCount(): number {
    return this.outboundQueueBytes;
  }

  connect(): void {
    this.ensureSocket();
  }

  allocatePortId(): string {
    return `message_port_${this.nextRequestId()}`;
  }

  invoke(channel: string, args: unknown[]): Promise<unknown> {
    const requestId = this.nextRequestId();
    return new Promise((resolve, reject) => {
      if (!this.hasPendingCapacity()) {
        reject(new IpcBridgeCapacityError("Too many pending IPC requests."));
        return;
      }
      this.pendingInvokes.set(requestId, { resolve, reject });
      try {
        this.send({ type: "ipc-renderer-invoke", requestId, channel, args });
      } catch (error) {
        this.pendingInvokes.delete(requestId);
        reject(error);
      }
    });
  }

  requestDirectoryEntries(
    directoryPath: string | null,
  ): Promise<WorkspaceDirectoryEntries> {
    const requestId = this.nextRequestId();
    return new Promise((resolve, reject) => {
      if (!this.hasPendingCapacity()) {
        reject(new IpcBridgeCapacityError("Too many pending IPC requests."));
        return;
      }
      this.pendingDirectoryEntries.set(requestId, { resolve, reject });
      try {
        this.send({
          type: "workspace-directory-entries-request",
          requestId,
          directoryPath,
          directoriesOnly: true,
        });
      } catch (error) {
        this.pendingDirectoryEntries.delete(requestId);
        reject(error);
      }
    });
  }

  heartbeat(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendControlMessage("controller-heartbeat");
    }
  }

  takeControl(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendControlMessage("controller-take-control");
    }
  }

  send(message: RendererToMainMessage): void {
    const payload = serializeRendererToMainMessage(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendPayload(payload);
      return;
    }

    const payloadBytes = new TextEncoder().encode(payload).byteLength;
    if (
      this.outboundQueue.length >= MAX_OUTBOUND_QUEUE_MESSAGES ||
      this.outboundQueueBytes + payloadBytes > MAX_OUTBOUND_QUEUE_BYTES
    ) {
      throw new IpcBridgeCapacityError("The IPC outbound queue is full.");
    }
    this.outboundQueue.push({ payload, payloadBytes });
    this.outboundQueueBytes += payloadBytes;
    this.ensureSocket();
    this.flushOutboundQueue();
  }

  receive(rawData: unknown): void {
    if (
      new TextEncoder().encode(String(rawData)).byteLength >
      IPC_MAX_PAYLOAD_BYTES
    ) {
      console.error("[electron-stub] rejected oversized IPC bridge message");
      return;
    }
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(String(rawData));
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
      return;
    }
    const message = parseMainToRendererMessage(rawMessage);
    if (!message) {
      console.error("[electron-stub] rejected invalid IPC bridge message");
      return;
    }

    if (message.type === "ipc-renderer-invoke-result") {
      const pending = this.pendingInvokes.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pendingInvokes.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.errorMessage));
      }
      return;
    }

    if (message.type === "workspace-directory-entries-result") {
      const pending = this.pendingDirectoryEntries.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pendingDirectoryEntries.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.errorMessage));
      }
      return;
    }

    this.handleIncoming(message);
  }

  private hasPendingCapacity(): boolean {
    return this.pendingRequestCount < MAX_PENDING_REQUESTS;
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `ipc_bridge_${this.requestCounter}`;
  }

  private flushOutboundQueue(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.outboundQueue.length > 0) {
      const message = this.outboundQueue.shift();
      if (!message) {
        return;
      }
      this.outboundQueueBytes -= message.payloadBytes;
      this.sendPayload(message.payload);
      if (this.socket?.readyState !== WebSocket.OPEN) {
        return;
      }
    }
  }

  private sendControlMessage(
    type:
      | "controller-connect"
      | "controller-heartbeat"
      | "controller-take-control",
  ): void {
    this.sendPayload(
      serializeRendererToMainMessage({ type, clientId: this.clientId }),
    );
  }

  private sendPayload(payload: string): void {
    try {
      this.socket?.send(payload);
    } catch {
      // A send may have reached the peer before throwing; do not replay it.
      this.onSocketDisconnected();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeoutId !== null) {
      return;
    }
    this.reconnectTimeoutId = this.setReconnectTimeout(() => {
      this.reconnectTimeoutId = null;
      this.ensureSocket();
    }, RECONNECT_DELAY_MS);
  }

  private ensureSocket(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const socket = this.createSocket(this.url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.sendControlMessage("controller-connect");
        this.flushOutboundQueue();
      });
      socket.addEventListener("message", (event) => this.receive(event.data));
      socket.addEventListener("close", () => this.onSocketDisconnected(socket));
      socket.addEventListener("error", () => this.scheduleReconnect());
    } catch {
      this.onSocketDisconnected();
    }
  }

  private onSocketDisconnected(disconnectedSocket?: BridgeWebSocket): void {
    if (disconnectedSocket && this.socket !== disconnectedSocket) {
      return;
    }
    this.socket = null;
    this.outboundQueue = [];
    this.outboundQueueBytes = 0;
    const error = new IpcBridgeDisconnectedError();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(error);
    }
    this.pendingInvokes.clear();
    for (const pending of this.pendingDirectoryEntries.values()) {
      pending.reject(error);
    }
    this.pendingDirectoryEntries.clear();
    this.handleDisconnect();
    this.scheduleReconnect();
  }
}

function getStableControllerClientId(): string {
  try {
    const existing = sessionStorage.getItem(CONTROLLER_STORAGE_KEY);
    if (existing) return existing;
    const clientId = crypto.randomUUID();
    sessionStorage.setItem(CONTROLLER_STORAGE_KEY, clientId);
    return clientId;
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}

const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "controller-status") {
    updateControllerStatus(message.status);
    return;
  }
  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }
}

let controllerStatusElement: HTMLDivElement | null = null;

function updateControllerStatus(status: "active" | "secondary"): void {
  const element = (controllerStatusElement ??= document.createElement("div"));
  element.setAttribute("role", "status");
  element.style.cssText =
    "position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 10px;border-radius:6px;background:#1f2937;color:#fff;font:12px system-ui;box-shadow:0 2px 8px #0006";
  element.replaceChildren();
  if (status === "active") {
    element.textContent = "This tab controls Codex";
  } else {
    element.append("View-only tab. ");
    const takeControl = document.createElement("button");
    takeControl.type = "button";
    takeControl.textContent = "Take control";
    takeControl.style.cssText = "margin-left:6px;font:inherit";
    takeControl.addEventListener("click", () => ipcTransport.takeControl());
    element.append(takeControl);
  }
  if (!element.isConnected) document.body.append(element);
}

const ipcTransport = new IpcBridgeTransport(
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  (url) => new WebSocket(url),
  handleIncomingMessage,
  () => {
    for (const port of messagePorts.values()) {
      port.close();
    }
    messagePorts.clear();
  },
);

window.setInterval(() => ipcTransport.heartbeat(), CONTROLLER_HEARTBEAT_MS);

function enqueueMessage(message: RendererToMainMessage): void {
  ipcTransport.send(message);
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  return ipcTransport.invoke(channel, args);
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  return ipcTransport.requestDirectoryEntries(directoryPath);
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: __ELECTRON_EMULATION_VERSION__,
    },
  },
});

electronShim.overrideAdapter = {
  getGateOverride(evaluation) {
    if (evaluation.name === "2911712394") {
      return {
        ...evaluation,
        value: true,
      };
    }

    if (evaluation.name === "1042620455") {
      // Remote control (Slingshot).
      return {
        ...evaluation,
        value: true,
      };
    }

    return null;
  },
};

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      const message = args[0];

      if (isOpenInBrowserMessage(message)) {
        window.open(message.url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(message)) {
        return handleLocalFilePickerMessage(message);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(message)) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...message, root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = ipcTransport.allocatePortId();
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ipcTransport.connect();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return unimplemented("webUtils.getPathForFile");
  },
};

import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
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
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
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

const RECONNECT_DELAY_MS = 1_000;

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

let requestCounter = 0;
let socket: WebSocket | null = null;
let needsReload = false;
let reconnectTimeoutId: number | null = null;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
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
  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
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

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    socket.send(JSON.stringify(message));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  socket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket.addEventListener("open", () => {
    // App-host RPC transfers MessagePorts once at startup. A new connection needs
    // a fresh app view; replaying requests against the closed ports cannot recover it.
    if (needsReload) {
      window.location.reload();
      return;
    }
    flushOutboundQueue();
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  socket.addEventListener("close", () => {
    needsReload = true;
    const error = new Error("Connection to Codex was lost");
    for (const pending of pendingInvokes.values()) pending.reject(error);
    pendingInvokes.clear();
    for (const pending of pendingDirectoryEntries.values())
      pending.reject(error);
    pendingDirectoryEntries.clear();
    outboundQueue.length = 0;
    for (const port of messagePorts.values()) {
      port.close();
    }
    messagePorts.clear();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
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
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

type BrowserMenuEntry = {
  id?: string;
  type?: string;
  checked?: boolean;
  label?: string;
  accelerator?: string;
  enabled?: boolean;
  toolTip?: string;
  submenu?: BrowserMenuEntry[];
  run?: () => void | Promise<void>;
};

let menuRoot: HTMLDivElement | null = null;
let menuDismiss: (() => void) | null = null;
let lastPointerX = 0;
let lastPointerY = 0;

// The shell invokes showContextMenu synchronously from the event handler, so
// the most recent pointer position is the trigger position.
document.addEventListener(
  "pointerdown",
  (event) => {
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  },
  true,
);
document.addEventListener(
  "contextmenu",
  (event) => {
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  },
  true,
);

const MENU_PANEL_CSS = [
  "position:fixed",
  "z-index:10000",
  "min-width:190px",
  "padding:4px",
  "border-radius:10px",
  "border:1px solid rgba(128,128,128,.35)",
  "background:var(--color-bg-primary, #ffffff)",
  "color:var(--color-text-primary, #111111)",
  "box-shadow:0 8px 24px rgba(0,0,0,.28)",
  "font:13px/1.45 system-ui, sans-serif",
].join(";");

const MENU_ITEM_CSS = [
  "display:flex",
  "align-items:center",
  "width:100%",
  "text-align:left",
  "padding:6px 10px",
  "border:0",
  "border-radius:6px",
  "background:transparent",
  "color:inherit",
].join(";");

function closeAllMenus(): void {
  menuRoot?.remove();
  menuRoot = null;
  menuDismiss = null;
}

function positionPanel(panel: HTMLDivElement, x: number, y: number): void {
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  const rect = panel.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    panel.style.left = `${Math.max(4, x - rect.width)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    panel.style.top = `${Math.max(4, y - rect.height)}px`;
  }
}

function openMenuPanel(
  x: number,
  y: number,
  items: BrowserMenuEntry[],
  onPick: (entry: BrowserMenuEntry | null) => void,
  depth: number,
): void {
  if (!menuRoot) {
    return;
  }
  for (const existing of Array.from(
    menuRoot.querySelectorAll<HTMLElement>("[data-menu-depth]"),
  )) {
    if (Number(existing.dataset.menuDepth) >= depth) {
      existing.remove();
    }
  }

  const panel = document.createElement("div");
  panel.setAttribute("role", "menu");
  panel.dataset.menuDepth = String(depth);
  panel.style.cssText = MENU_PANEL_CSS;

  for (const item of items) {
    if (item.type === "separator") {
      const separator = document.createElement("div");
      separator.style.cssText =
        "height:1px;margin:4px 8px;background:rgba(128,128,128,.35)";
      panel.appendChild(separator);
      continue;
    }

    const enabled = item.enabled !== false;
    const row = document.createElement("button");
    row.type = "button";
    row.setAttribute(
      "role",
      item.checked === undefined ? "menuitem" : "menuitemcheckbox",
    );
    if (item.checked) {
      row.setAttribute("aria-checked", "true");
    }
    row.disabled = !enabled;
    row.title = item.toolTip ?? "";
    row.style.cssText = `${MENU_ITEM_CSS};cursor:${
      enabled ? "pointer" : "default"
    };opacity:${enabled ? 1 : 0.45}`;

    const label = document.createElement("span");
    label.textContent = item.label ?? "";
    label.style.cssText = "flex:1;text-align:left";
    row.appendChild(label);

    if (item.accelerator) {
      const accelerator = document.createElement("span");
      accelerator.textContent = item.accelerator;
      accelerator.style.cssText = "opacity:.55;font-size:11px;margin-left:18px";
      row.appendChild(accelerator);
    }

    if (item.submenu && item.submenu.length > 0) {
      const caret = document.createElement("span");
      caret.textContent = "\u25B8";
      caret.style.cssText = "opacity:.6;margin-left:12px";
      row.appendChild(caret);
      row.addEventListener("mouseenter", () => {
        const rect = row.getBoundingClientRect();
        openMenuPanel(rect.right - 6, rect.top - 6, item.submenu ?? [], onPick, depth + 1);
      });
    } else {
      row.addEventListener("click", () => {
        if (enabled) {
          onPick(item);
        }
      });
    }
    panel.appendChild(row);
  }

  menuRoot.appendChild(panel);
  positionPanel(panel, x, y);
}

function openBrowserMenu(
  x: number,
  y: number,
  items: BrowserMenuEntry[],
  onPick: (entry: BrowserMenuEntry | null) => void,
): void {
  closeAllMenus();
  const root = document.createElement("div");
  root.style.cssText = "position:fixed;inset:0;z-index:9999";
  root.addEventListener("contextmenu", (event) => event.preventDefault());
  root.addEventListener("mousedown", (event) => {
    if (event.target === root) {
      onPick(null);
    }
  });
  document.body.appendChild(root);
  menuRoot = root;
  menuDismiss = () => onPick(null);
  openMenuPanel(x, y, items, onPick, 0);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuRoot) {
    menuDismiss?.();
  }
});
window.addEventListener("blur", closeAllMenus);
window.addEventListener("resize", closeAllMenus);

function conversationSurfaceFor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  if (target.closest("input, textarea, select, [contenteditable='true']")) {
    return null;
  }
  return target.closest("main");
}

// The desktop shell shows a native text-editing context menu inside the
// conversation (it comes from the webContents `context-menu` event, which a
// browser renderer never produces), and installed-PWA windows suppress the
// browser's own menu too. Provide an equivalent, but only where the app did
// not already handle the event.
// Click-triggered menus (the thread "..." overflow, exposed as
// button[aria-label="Chat actions"]) lose their trigger once the shell falls
// back to its React context menu: that fallback only wires onContextMenu, so
// clicking the button does nothing. Translate the click into the contextmenu
// event the fallback listens for, at the button's position.
document.addEventListener(
  "click",
  (event) => {
    // The click usually lands on the button's SVG icon, which is an
    // SVGElement rather than an HTMLElement, so test for Element.
    const target = event.target instanceof Element ? event.target : null;
    const trigger = target?.closest(
      "button[aria-haspopup='menu'][aria-label='Chat actions']",
    );
    if (!trigger) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = trigger.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    // The overflow button lives in an overlay outside the row element, while
    // the context menu trigger wraps the row itself, so re-target the
    // synthesized event at the row the button visually belongs to.
    const row = Array.from(
      document.querySelectorAll("[data-app-action-sidebar-thread-row]"),
    ).find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return (
        x >= bounds.left &&
        x <= bounds.right &&
        y >= bounds.top &&
        y <= bounds.bottom
      );
    });
    const scope = row ?? trigger;
    const triggerElement =
      scope.querySelector?.("[data-thread-title-trigger]") ?? scope;
    // Defer so the synthetic gesture is decoupled from the real click's
    // pointer sequence; otherwise the menu library consumes the next real
    // click as the release of the opening gesture and item clicks die.
    setTimeout(() => {
      triggerElement.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: 2,
          clientX: x,
          clientY: y,
        }),
      );
    }, 0);
  },
  true,
);

document.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented) {
    return;
  }
  const surface = conversationSurfaceFor(event.target);
  if (!surface) {
    return;
  }
  event.preventDefault();

  const selection = window.getSelection()?.toString() ?? "";
  const message =
    (event.target instanceof Element &&
      event.target.closest("pre, code, p, [class*='markdown']")) ||
    surface;
  const threadId =
    window.location.pathname.match(/^\/thread\/([^/]+)/)?.[1] ?? null;

  openBrowserMenu(event.clientX, event.clientY, [
    {
      id: "copy",
      label: "Copy",
      enabled: selection.length > 0,
      run: () => navigator.clipboard.writeText(selection),
    },
    {
      id: "select-message",
      label: "Select message",
      run: () => {
        const range = document.createRange();
        range.selectNodeContents(message);
        const current = window.getSelection();
        current?.removeAllRanges();
        current?.addRange(range);
      },
    },
    {
      id: "copy-thread-link",
      label: "Copy thread link",
      enabled: threadId != null,
      run: () => navigator.clipboard.writeText(window.location.href),
    },
  ], () => undefined);
});


Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
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
      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
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

        const portId = `message_port_${nextRequestId()}`;
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

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return null;
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    // The shell hands context menus to the native Electron menu whenever
    // `showContextMenu` is present on the bridge. There is no native menu in a
    // browser, so that invoke never settles and every menu routed through it
    // hangs. Dropping the method makes the shell fall back to its own React
    // context menu, which renders and works here. Click-triggered menus (the
    // thread "..." overflow) are re-attached below by synthesizing the
    // contextmenu event the fallback listens for.
    if (isRecord(_api) && "showContextMenu" in _api) {
      const { showContextMenu: _showContextMenu, ...rest } = _api;
      Reflect.set(window, _key, rest);
      return;
    }

    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return unimplemented("webUtils.getPathForFile");
  },
};

/* eslint-disable no-console */

import type {
  BridgeMessage,
  ElectronBridge,
  ThemeVariant,
  WorkerMessageListener,
} from "./interface";
import { registerElectronBridgeInterface } from "./interface";

type SharedObjectSetMessage = {
  key: string;
  type: "shared-object-set";
  value: unknown;
};

const BUILD_FLAVOR = "dev";
const LOG_PREFIX = "[bridge-stub]";
const SESSION_ID = "stub-session-id";
const WINDOW_TYPE = "electron";

const sharedObjectSnapshot = new Map<string, unknown>();
const workerListeners = new Map<string, Set<WorkerMessageListener>>();
const systemThemeListeners = new Set<() => void>();

const mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
let systemThemeVariant: ThemeVariant = mediaQueryList.matches
  ? "dark"
  : "light";

function log(method: string, payload?: unknown): void {
  if (payload === undefined) {
    console.info(`${LOG_PREFIX} ${method}`);
    return;
  }

  console.info(`${LOG_PREFIX} ${method}`, payload);
}

function isSharedObjectSetMessage(
  message: BridgeMessage,
): message is SharedObjectSetMessage {
  return (
    message.type === "shared-object-set" && typeof message.key === "string"
  );
}

function getOrCreateWorkerListeners(
  workerName: string,
): Set<WorkerMessageListener> {
  let listeners = workerListeners.get(workerName);
  if (listeners) {
    return listeners;
  }

  listeners = new Set<WorkerMessageListener>();
  workerListeners.set(workerName, listeners);
  return listeners;
}

function dispatchStubWindowMessage(message: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: message,
    }),
  );
}

mediaQueryList.addEventListener("change", (event) => {
  systemThemeVariant = event.matches ? "dark" : "light";
  log("subscribeToSystemThemeVariant.notify", {
    systemThemeVariant,
    listenerCount: systemThemeListeners.size,
  });
  systemThemeListeners.forEach((listener) => {
    listener();
  });
});

registerElectronBridgeInterface({
  windowType: WINDOW_TYPE,
  async sendMessageFromView(message) {
    log("sendMessageFromView", message);

    if (isSharedObjectSetMessage(message)) {
      sharedObjectSnapshot.set(message.key, message.value);
    }
  },
  getPathForFile(file) {
    const filePath = (file as File & { path?: unknown }).path;
    const result = typeof filePath === "string" ? filePath : null;
    log("getPathForFile", {
      fileName: file.name,
      resolvedPath: result,
    });
    return result;
  },
  async sendWorkerMessageFromView(workerName, message) {
    log("sendWorkerMessageFromView", {
      workerName,
      message,
    });

    const listeners = workerListeners.get(workerName);
    if (!listeners || listeners.size === 0) {
      return;
    }

    listeners.forEach((listener) => {
      listener(message);
    });
  },
  subscribeToWorkerMessages(workerName, listener) {
    log("subscribeToWorkerMessages.register", {
      workerName,
    });

    const listeners = getOrCreateWorkerListeners(workerName);
    listeners.add(listener);

    return () => {
      log("subscribeToWorkerMessages.unregister", {
        workerName,
      });
      const currentListeners = workerListeners.get(workerName);
      if (!currentListeners) {
        return;
      }

      currentListeners.delete(listener);
      if (currentListeners.size === 0) {
        workerListeners.delete(workerName);
      }
    };
  },
  async showContextMenu(payload) {
    log("showContextMenu", payload);
  },
  async showApplicationMenu(menuId, x, y) {
    log("showApplicationMenu", {
      menuId,
      x,
      y,
    });
  },
  async getFastModeRolloutMetrics(input) {
    log("getFastModeRolloutMetrics", input);
    return {
      enabled: false,
      source: "bridge-stub",
    };
  },
  getSharedObjectSnapshotValue(key) {
    const value = sharedObjectSnapshot.get(key);
    log("getSharedObjectSnapshotValue", {
      key,
      hasValue: value !== undefined,
    });
    return value;
  },
  getSystemThemeVariant() {
    log("getSystemThemeVariant", {
      systemThemeVariant,
    });
    return systemThemeVariant;
  },
  subscribeToSystemThemeVariant(listener) {
    log("subscribeToSystemThemeVariant.register", {
      listenerCountBefore: systemThemeListeners.size,
    });

    systemThemeListeners.add(listener);

    return () => {
      log("subscribeToSystemThemeVariant.unregister", {
        listenerCountBefore: systemThemeListeners.size,
      });
      systemThemeListeners.delete(listener);
    };
  },
  async triggerSentryTestError() {
    log("triggerSentryTestError");
  },
  getSentryInitOptions() {
    log("getSentryInitOptions");
    return {
      codexAppSessionId: SESSION_ID,
    };
  },
  getAppSessionId() {
    log("getAppSessionId");
    return SESSION_ID;
  },
  getBuildFlavor() {
    log("getBuildFlavor");
    return BUILD_FLAVOR;
  },
});

dispatchStubWindowMessage({
  type: "bridge-stub-ready",
  windowType: WINDOW_TYPE,
});

log("installed", {
  windowType: window.codexWindowType,
});

export {};

export type Unsubscribe = () => void;

export type WorkerMessageListener = (message: unknown) => void;

export type BridgeMessage = {
  type?: unknown;
  [key: string]: unknown;
};

export type ThemeVariant = "light" | "dark";

export interface ElectronBridge {
  windowType: string;
  sendMessageFromView: (message: BridgeMessage) => Promise<void>;
  getPathForFile: (file: File) => string | null;
  sendWorkerMessageFromView: (
    workerName: string,
    message: unknown,
  ) => Promise<void>;
  subscribeToWorkerMessages: (
    workerName: string,
    listener: WorkerMessageListener,
  ) => Unsubscribe;
  showContextMenu: (payload: unknown) => Promise<void>;
  showApplicationMenu: (menuId: string, x: number, y: number) => Promise<void>;
  getFastModeRolloutMetrics: (input: unknown) => Promise<unknown>;
  getSharedObjectSnapshotValue: (key: string) => unknown;
  getSystemThemeVariant: () => ThemeVariant;
  subscribeToSystemThemeVariant: (listener: () => void) => Unsubscribe;
  triggerSentryTestError: () => Promise<void>;
  getSentryInitOptions: () => { codexAppSessionId: string };
  getAppSessionId: () => string;
  getBuildFlavor: () => string;
}

declare global {
  interface Window {
    codexWindowType: string;
    electronBridge: ElectronBridge;
  }
}

export function registerElectronBridgeInterface(
  electronBridge: ElectronBridge,
): void {
  window.codexWindowType = electronBridge.windowType;
  window.electronBridge = electronBridge;
}

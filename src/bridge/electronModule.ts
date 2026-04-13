type IpcListener = (event: unknown, ...args: unknown[]) => void;

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export const ipcRenderer = {
  invoke(_channel: string, ..._args: unknown[]): Promise<unknown> {
    return unimplemented("ipcRenderer.invoke");
  },
  on(_channel: string, _listener: IpcListener): unknown {
    return unimplemented("ipcRenderer.on");
  },
  removeListener(_channel: string, _listener: IpcListener): unknown {
    return unimplemented("ipcRenderer.removeListener");
  },
  send(_channel: string, ..._args: unknown[]): void {
    return unimplemented("ipcRenderer.send");
  },
  sendSync(_channel: string, ..._args: unknown[]): unknown {
    return unimplemented("ipcRenderer.sendSync");
  },
};

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

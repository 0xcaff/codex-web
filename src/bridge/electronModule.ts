type IpcListener = (event: unknown, ...args: unknown[]) => void;

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export const ipcRenderer = {
  invoke(_channel: string, ..._args: unknown[]): Promise<unknown> {
    console.log("ipcRenderer.invoke", _channel, _args);
    return new Promise(() => {});
  },
  on(channel: string, listener: IpcListener): unknown {
    console.log("ipcRenderer.on", channel, listener);
    return this;
  },
  removeListener(_channel: string, _listener: IpcListener): unknown {
    return unimplemented("ipcRenderer.removeListener");
  },
  send(_channel: string, ..._args: unknown[]): void {
    return unimplemented("ipcRenderer.send");
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor: "dev",
        buildNumber: null,
        appVersion: "26.409.20454",
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return "dev";
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: {
          id: "local",
          display_name: "Local",
          kind: "local",
        },
        remote_connections: [
          {
            hostId: "remote-ssh-discovered:nixos",
            displayName: "nixos",
            source: "discovered",
            autoConnect: false,
            sshAlias: "nixos",
            sshHost: "nixos",
            sshPort: 22,
            identity: "~/.ssh/id_ed25519",
          },
        ],
        remote_control_connections_state: {
          available: true,
          authRequired: false,
        },
        pending_worktrees: [],
        statsig_default_enable_features: {
          enable_request_compression: true,
          collaboration_modes: true,
          personality: true,
          request_rule: true,
          fast_mode: true,
          image_detail_original: true,
          apps: true,
          plugins: true,
          tool_search: true,
          tool_suggest: false,
          tool_call_mcp_elicitation: true,
        },
      };
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return "light";
    }

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

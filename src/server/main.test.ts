import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  formatHttpUrl,
  getServerStartupReport,
  getTrustedNetworkUrls,
  IPC_MAX_PAYLOAD_BYTES,
  isAllowedIpcOrigin,
  parseRendererToMainMessage,
  parseServerArgs,
  startIpcBridgeServer,
} from "./main";

describe("server CLI and trusted-network reporting", () => {
  it("defaults to loopback and supports an explicit LAN alias", () => {
    expect(parseServerArgs([])).toMatchObject({
      allowedOrigins: [],
      host: "127.0.0.1",
      port: 8214,
    });
    expect(parseServerArgs(["--lan"])).toMatchObject({ host: "0.0.0.0" });
  });

  it("rejects conflicting host choices and invalid ports", () => {
    expect(() => parseServerArgs(["--lan", "--host", "127.0.0.1"])).toThrow(
      "--lan cannot be combined with --host",
    );
    for (const port of ["0", "65536", "not-a-port"]) {
      expect(() => parseServerArgs(["--port", port])).toThrow("Invalid port");
    }
    expect(() => parseServerArgs(["--port=-1"])).toThrow("Invalid port");
  });

  it("formats IPv6 and reports a deterministic non-loopback URL set", () => {
    const networkInterfaces = () => ({
      ignored: [
        { address: "127.0.0.1", family: "IPv4", internal: true },
        { address: "10.0.0.7", family: "IPv4", internal: false },
      ],
      alsoIgnored: [
        { address: "203.0.113.9", family: "IPv4", internal: false },
        { address: "fe80::a", family: "IPv6", internal: false },
        { address: "10.0.0.7", family: "IPv4", internal: false },
        { address: "00:11:22:33:44:55", family: "MAC", internal: false },
      ],
    });
    expect(formatHttpUrl("fe80::a", 8214)).toBe("http://[fe80::a]:8214");
    expect(getTrustedNetworkUrls(8214, networkInterfaces)).toEqual([
      "http://[fe80::a]:8214",
      "http://10.0.0.7:8214",
      "http://203.0.113.9:8214",
    ]);
    const lanReport = getServerStartupReport(
      { allowedOrigins: [], host: "0.0.0.0", port: 8214 },
      8214,
      networkInterfaces,
    );
    expect(lanReport).toContain("  http://10.0.0.7:8214");
    expect(lanReport).toContain("  http://203.0.113.9:8214");
    expect(lanReport).not.toContain("  http://[fe80::a]:8214");
    expect(lanReport).toContain(
      "TRUSTED NETWORK WARNING: anyone who can reach this service can operate Codex with the permissions and credentials of this host user. Do not expose it to an untrusted network or the public internet.",
    );
  });
});

type IpcBridgeGlobals = typeof globalThis & {
  __codexElectronIpcBridge?: {
    handleRendererInvoke?: (
      channel: string,
      args: unknown[],
      sourceUrl?: string,
    ) => Promise<unknown>;
    handleRendererPostMessage?: (
      channel: string,
      message: unknown,
      ports: unknown[],
      sourceUrl?: string,
    ) => void;
  };
};

afterEach(() => {
  delete (globalThis as IpcBridgeGlobals).__codexElectronIpcBridge;
});

async function connectIpc(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/__backend/ipc`, {
    origin: `http://127.0.0.1:${port}`,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function nextIpcMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
}

describe("IPC bridge origin policy", () => {
  it("accepts an exact origin matching the effective loopback or LAN Host", () => {
    expect(
      isAllowedIpcOrigin("http://127.0.0.1:8214", "127.0.0.1:8214", []),
    ).toBe(true);
    expect(
      isAllowedIpcOrigin("http://192.168.1.9:8214", "192.168.1.9:8214", []),
    ).toBe(true);
  });

  it("accepts only an exact configured reverse-proxy origin", () => {
    const options = parseServerArgs([
      "--allowed-origin",
      "https://codex.example.test:8443",
    ]);
    expect(
      isAllowedIpcOrigin(
        "https://codex.example.test:8443",
        "127.0.0.1:8214",
        options.allowedOrigins,
      ),
    ).toBe(true);
    expect(() =>
      parseServerArgs(["--allowed-origin", "https://*.example.test"]),
    ).toThrow("Invalid --allowed-origin");
  });

  it("rejects missing, null, malformed, and hostile origins", () => {
    for (const origin of [
      undefined,
      "null",
      "file:///tmp/page",
      "https://evil.test",
    ]) {
      expect(isAllowedIpcOrigin(origin, "127.0.0.1:8214", [])).toBe(false);
    }
  });
});

describe("IPC message envelope", () => {
  it("accepts exact browser invoke/send envelopes without sourceUrl", () => {
    expect(
      parseRendererToMainMessage(
        Buffer.from(
          '{"type":"ipc-renderer-invoke","requestId":"1","channel":"test","args":[]}',
        ),
        false,
      ),
    ).not.toBeNull();
    expect(
      parseRendererToMainMessage(
        Buffer.from('{"type":"ipc-renderer-send","channel":"test","args":[]}'),
        false,
      ),
    ).not.toBeNull();
  });

  it("rejects malformed, wrongly typed, and oversized data", () => {
    expect(parseRendererToMainMessage(Buffer.from("{}"), false)).toBeNull();
    expect(
      parseRendererToMainMessage(
        Buffer.from(
          '{"type":"ipc-renderer-send","channel":"test","args":[],"sourceUrl":42}',
        ),
        false,
      ),
    ).toBeNull();
    expect(
      parseRendererToMainMessage(
        Buffer.alloc(IPC_MAX_PAYLOAD_BYTES + 1),
        false,
      ),
    ).toBeNull();
  });
});

describe("IPC bridge readiness", () => {
  it("returns a deterministic unavailable error rather than dropping an early invoke", async () => {
    const bridge = await startIpcBridgeServer(
      { host: "127.0.0.1", port: 0, allowedOrigins: [] },
      { startMainApp: false },
    );
    const socket = await connectIpc(bridge.port);
    socket.send(
      JSON.stringify({
        type: "ipc-renderer-invoke",
        requestId: "early",
        channel: "not-ready",
        args: [],
      }),
    );

    await expect(nextIpcMessage(socket)).resolves.toMatchObject({
      type: "ipc-renderer-invoke-result",
      requestId: "early",
      ok: false,
      errorMessage: expect.stringContaining("unavailable"),
    });
    socket.close();
    await bridge.close();
  });

  it("binds while the upstream lifecycle promise remains pending", async () => {
    let bootstrapped = false;
    const bridge = await startIpcBridgeServer(
      { host: "127.0.0.1", port: 0, allowedOrigins: [] },
      {
        bootstrapMainApp: () => {
          bootstrapped = true;
          const globals = globalThis as IpcBridgeGlobals;
          const bridgeState = (globals.__codexElectronIpcBridge ??= {});
          bridgeState.handleRendererInvoke = async (channel, args) => ({
            channel,
            args,
          });
          return new Promise<void>(() => undefined);
        },
      },
    );
    expect(bootstrapped).toBe(true);

    const socket = await connectIpc(bridge.port);
    socket.send(
      JSON.stringify({
        type: "ipc-renderer-invoke",
        requestId: "ready",
        channel: "ready-channel",
        args: ["value"],
      }),
    );

    await expect(nextIpcMessage(socket)).resolves.toMatchObject({
      type: "ipc-renderer-invoke-result",
      requestId: "ready",
      ok: true,
      result: { channel: "ready-channel", args: ["value"] },
    });
    socket.close();
    await bridge.close();
  });

  it("preserves an undefined handler result as a successful invoke response", async () => {
    const bridge = await startIpcBridgeServer(
      { host: "127.0.0.1", port: 0, allowedOrigins: [] },
      {
        bootstrapMainApp: () => {
          const globals = globalThis as IpcBridgeGlobals;
          const bridgeState = (globals.__codexElectronIpcBridge ??= {});
          bridgeState.handleRendererInvoke = async () => undefined;
        },
      },
    );
    const socket = await connectIpc(bridge.port);
    socket.send(
      JSON.stringify({
        type: "ipc-renderer-invoke",
        requestId: "undefined-result",
        channel: "no-result",
        args: [],
      }),
    );

    await expect(nextIpcMessage(socket)).resolves.toEqual({
      type: "ipc-renderer-invoke-result",
      requestId: "undefined-result",
      ok: true,
    });
    socket.close();
    await bridge.close();
  });

  it("delivers an omitted postMessage payload to the Electron handler as undefined", async () => {
    let resolveDelivered: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });
    let receivedPayload: unknown = null;
    const bridge = await startIpcBridgeServer(
      { host: "127.0.0.1", port: 0, allowedOrigins: [] },
      {
        bootstrapMainApp: () => {
          const globals = globalThis as IpcBridgeGlobals;
          const bridgeState = (globals.__codexElectronIpcBridge ??= {});
          bridgeState.handleRendererPostMessage = (_channel, message) => {
            receivedPayload = message;
            resolveDelivered?.();
          };
        },
      },
    );
    const socket = await connectIpc(bridge.port);
    socket.send(
      JSON.stringify({
        type: "ipc-renderer-post-message",
        channel: "undefined-payload",
        portIds: [],
      }),
    );

    await delivered;
    expect(receivedPayload).toBeUndefined();
    socket.close();
    await bridge.close();
  });

  it("logs a startup rejection without preventing HTTP binding", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const bridge = await startIpcBridgeServer(
      { host: "127.0.0.1", port: 0, allowedOrigins: [] },
      {
        bootstrapMainApp: async () => {
          throw new Error("startup failed");
        },
      },
    );
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(
      "[ipc-bridge] startup failed",
      expect.any(Error),
    );
    error.mockRestore();
    await bridge.close();
  });
});

describe("IPC connection and reload behavior", () => {
  it("delivers opaque bootstrap postMessage traffic on initial and replacement sockets", async () => {
    const deliveries: string[] = [];
    const bridge = await startIpcBridgeServer(
      { host: "127.0.0.1", port: 0, allowedOrigins: [] },
      {
        bootstrapMainApp: () => {
          const globals = globalThis as IpcBridgeGlobals;
          const bridgeState = (globals.__codexElectronIpcBridge ??= {});
          bridgeState.handleRendererPostMessage = (channel) => {
            deliveries.push(channel);
          };
        },
      },
    );
    const first = await connectIpc(bridge.port);
    first.send(
      JSON.stringify({
        type: "ipc-renderer-post-message",
        channel: "bootstrap-initial",
        portIds: [],
      }),
    );
    await vi.waitFor(() => expect(deliveries).toEqual(["bootstrap-initial"]));
    first.close();

    const replacement = await connectIpc(bridge.port);
    replacement.send(
      JSON.stringify({
        type: "ipc-renderer-post-message",
        channel: "bootstrap-reload",
        portIds: [],
      }),
    );
    await vi.waitFor(() =>
      expect(deliveries).toEqual(["bootstrap-initial", "bootstrap-reload"]),
    );
    replacement.close();
    await bridge.close();
  });
});

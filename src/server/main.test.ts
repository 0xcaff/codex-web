import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  IPC_MAX_PAYLOAD_BYTES,
  isAllowedIpcOrigin,
  parseRendererToMainMessage,
  parseServerArgs,
  startIpcBridgeServer,
} from "./main";

type IpcBridgeGlobals = typeof globalThis & {
  __codexElectronIpcBridge?: {
    handleRendererInvoke?: (
      channel: string,
      args: unknown[],
      sourceUrl?: string,
    ) => Promise<unknown>;
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

  it("awaits bootstrap before exposing a handler-backed bridge", async () => {
    let bootstrapped = false;
    const bridge = await startIpcBridgeServer(
      { host: "127.0.0.1", port: 0, allowedOrigins: [] },
      {
        bootstrapMainApp: async () => {
          await Promise.resolve();
          bootstrapped = true;
          const globals = globalThis as IpcBridgeGlobals;
          const bridgeState = (globals.__codexElectronIpcBridge ??= {});
          bridgeState.handleRendererInvoke = async (channel, args) => ({
            channel,
            args,
          });
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

  it("rejects startup failure without binding a usable bridge", async () => {
    await expect(
      startIpcBridgeServer(
        { host: "127.0.0.1", port: 0, allowedOrigins: [] },
        {
          bootstrapMainApp: async () => {
            throw new Error("startup failed");
          },
        },
      ),
    ).rejects.toThrow("startup failed");
  });
});

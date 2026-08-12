import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  private emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data });
    }
  }
}

let IpcBridgeCapacityError: typeof import("./shim").IpcBridgeCapacityError;
let IpcBridgeDisconnectedError: typeof import("./shim").IpcBridgeDisconnectedError;
let IpcBridgeTransport: typeof import("./shim").IpcBridgeTransport;

beforeAll(async () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("__ELECTRON_EMULATION_VERSION__", "test-electron");
  const shim = await import("./shim");
  IpcBridgeCapacityError = shim.IpcBridgeCapacityError;
  IpcBridgeDisconnectedError = shim.IpcBridgeDisconnectedError;
  IpcBridgeTransport = shim.IpcBridgeTransport;
});

afterAll(() => vi.unstubAllGlobals());

function createTransport() {
  const sockets: FakeWebSocket[] = [];
  const reconnectCallbacks: Array<() => void> = [];
  const transport = new IpcBridgeTransport(
    "ws://test/__backend/ipc",
    (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    () => undefined,
    () => undefined,
    (callback) => {
      reconnectCallbacks.push(callback);
      return reconnectCallbacks.length;
    },
  );
  return { reconnectCallbacks, sockets, transport };
}

describe("IPC browser transport", () => {
  it("settles pending requests once and clears every request map on disconnect", async () => {
    const { sockets, transport } = createTransport();
    const invoke = transport.invoke("test", []);
    const directory = transport.requestDirectoryEntries(null);
    sockets[0]?.open();
    sockets[0]?.close();
    sockets[0]?.close();

    await expect(invoke).rejects.toBeInstanceOf(IpcBridgeDisconnectedError);
    await expect(directory).rejects.toBeInstanceOf(IpcBridgeDisconnectedError);
    expect(transport.pendingRequestCount).toBe(0);
  });

  it("caps the unsent queue by message count", () => {
    const { transport } = createTransport();
    for (let index = 0; index < 128; index += 1) {
      transport.send({
        type: "ipc-renderer-send",
        channel: `test-${index}`,
        args: [],
      });
    }

    expect(() =>
      transport.send({
        type: "ipc-renderer-send",
        channel: "overflow",
        args: [],
      }),
    ).toThrow(IpcBridgeCapacityError);
    expect(transport.queuedMessageCount).toBe(128);
  });

  it("caps the unsent queue by estimated serialized bytes", () => {
    const { transport } = createTransport();
    transport.send({
      type: "ipc-renderer-send",
      channel: "large",
      args: ["x".repeat(150 * 1024)],
    });

    expect(() =>
      transport.send({
        type: "ipc-renderer-send",
        channel: "large",
        args: ["x".repeat(150 * 1024)],
      }),
    ).toThrow(IpcBridgeCapacityError);
    expect(transport.queuedByteCount).toBeGreaterThan(0);
  });

  it("drops pre-disconnect work and sends only new work after reconnect", async () => {
    const { reconnectCallbacks, sockets, transport } = createTransport();
    const pending = transport.invoke("already-sent", []);
    sockets[0]?.open();
    expect(sockets[0]?.sent).toHaveLength(2);
    expect(sockets[0]?.sent[0]).toContain("controller-connect");
    sockets[0]?.close();
    await expect(pending).rejects.toBeInstanceOf(IpcBridgeDisconnectedError);

    reconnectCallbacks[0]?.();
    transport.send({
      type: "ipc-renderer-send",
      channel: "new-work",
      args: [],
    });
    sockets[1]?.open();

    expect(sockets[1]?.sent).toHaveLength(2);
    expect(sockets[1]?.sent[0]).toContain("controller-connect");
    expect(sockets[1]?.sent[1]).toContain("new-work");
  });
});

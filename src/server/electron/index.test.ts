import { describe, expect, it, vi } from "vitest";
import { formatElectronStubDebugCall, ipcMain } from "./index";

type StubPort = {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

type IpcBridgeGlobals = typeof globalThis & {
  __codexElectronIpcBridge?: {
    handleRendererPostMessage?: (
      channel: string,
      message: unknown,
      ports: StubPort[],
      sourceUrl?: string,
    ) => void;
  };
};

function port(): StubPort {
  return {
    close: vi.fn(),
    on: vi.fn(),
  };
}

describe("ipcMain postMessage buffering", () => {
  it("buffers only a bounded bootstrap channel and closes rejected or disconnected ports", () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const bridge = (globalThis as IpcBridgeGlobals).__codexElectronIpcBridge;
    expect(bridge?.handleRendererPostMessage).toBeTypeOf("function");

    const rejected = Array.from({ length: 8 }, () => port());
    for (const [index, messagePort] of rejected.entries()) {
      bridge?.handleRendererPostMessage?.(`unregistered-${index}`, undefined, [
        messagePort,
      ]);
    }
    expect(
      rejected.every(
        (messagePort) => messagePort.close.mock.calls.length === 1,
      ),
    ).toBe(true);

    const buffered = Array.from({ length: 4 }, () => port());
    for (const messagePort of buffered) {
      bridge?.handleRendererPostMessage?.(
        "codex_desktop:connect-app-host",
        undefined,
        [messagePort],
      );
    }
    const overflow = port();
    bridge?.handleRendererPostMessage?.(
      "codex_desktop:connect-app-host",
      undefined,
      [overflow],
    );
    expect(overflow.close).toHaveBeenCalledOnce();

    const closedListener = buffered[0]?.on.mock.calls.find(
      ([event]) => event === "close",
    )?.[1] as (() => void) | undefined;
    closedListener?.();
    const reclaimed = port();
    bridge?.handleRendererPostMessage?.(
      "codex_desktop:connect-app-host",
      undefined,
      [reclaimed],
    );
    expect(reclaimed.close).not.toHaveBeenCalled();

    const delivered: StubPort[][] = [];
    ipcMain.on("codex_desktop:connect-app-host", (event: unknown) => {
      delivered.push((event as { ports: StubPort[] }).ports);
    });
    expect(delivered).toHaveLength(4);
    expect(delivered.flat()).toContain(reclaimed);
    errors.mockRestore();
  });
});

describe("Electron stub tracing", () => {
  it("is silent by default", () => {
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const previous = process.env.CODEX_WEB_DEBUG;
    delete process.env.CODEX_WEB_DEBUG;

    ipcMain.handle("test:quiet-stub-trace", () => undefined);

    expect(debug).not.toHaveBeenCalled();
    if (previous === undefined) delete process.env.CODEX_WEB_DEBUG;
    else process.env.CODEX_WEB_DEBUG = previous;
    debug.mockRestore();
  });

  it("summarizes debug arguments without exposing values or unbounded payloads", () => {
    const message = formatElectronStubDebugCall("test", [
      "very-secret-token-value",
      { account: "person@example.test", nested: { body: "long content" } },
      Buffer.alloc(8_192),
      ["another secret", "and another"],
      "not included",
    ]);

    expect(message).toContain("[string 23 chars]");
    expect(message).toContain("{account, nested}");
    expect(message).toContain("[buffer 8192 bytes]");
    expect(message).toContain(", …)");
    expect(message).not.toContain("very-secret-token-value");
    expect(message).not.toContain("person@example.test");
    expect(message).not.toContain("long content");
    expect(message).not.toContain("not included");
  });
});

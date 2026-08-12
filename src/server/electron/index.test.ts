import { describe, expect, it, vi } from "vitest";
import { ipcMain } from "./index";

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

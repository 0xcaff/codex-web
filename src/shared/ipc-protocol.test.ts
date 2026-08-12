import { describe, expect, it } from "vitest";
import {
  IPC_MAX_ARRAY_LENGTH,
  IPC_MAX_MAIN_TO_RENDERER_PAYLOAD_BYTES,
  IPC_MAX_PAYLOAD_BYTES,
  isMainToRendererMessage,
  isRendererToMainMessage,
  parseMainToRendererMessage,
  parseRendererToMainMessage,
  serializeMainToRendererMessage,
  serializeRendererToMainMessage,
} from "./ipc-protocol";

describe("IPC wire protocol", () => {
  it("accepts every renderer-to-main envelope, including browser-compatible sourceUrl omission", () => {
    const messages = [
      {
        type: "controller-connect",
        clientId: "stable-tab-id",
      },
      {
        type: "ipc-renderer-invoke",
        requestId: "1",
        channel: "test",
        args: [],
      },
      { type: "ipc-renderer-send", channel: "test", args: [] },
      {
        type: "ipc-renderer-post-message",
        channel: "test",
        message: { hello: "world" },
        portIds: ["port-1"],
        sourceUrl: "http://localhost:5175",
      },
      { type: "message-port-message", portId: "port-1", data: null },
      { type: "message-port-close", portId: "port-1" },
      {
        type: "workspace-directory-entries-request",
        requestId: "2",
        directoryPath: null,
        directoriesOnly: true,
      },
    ];

    for (const message of messages) {
      expect(isRendererToMainMessage(message)).toBe(true);
      expect(parseRendererToMainMessage(message)).toEqual(message);
    }
  });

  it("accepts every main-to-renderer envelope", () => {
    const messages = [
      { type: "ipc-main-event", channel: "event", args: [] },
      { type: "controller-status", status: "active" },
      {
        type: "ipc-renderer-invoke-result",
        requestId: "1",
        ok: true,
        result: { value: true },
      },
      {
        type: "ipc-renderer-invoke-result",
        requestId: "1",
        ok: false,
        errorMessage: "unavailable",
      },
      {
        type: "workspace-directory-entries-result",
        requestId: "2",
        ok: true,
        result: {
          directoryPath: "/tmp",
          parentPath: "/",
          entries: [{ name: "child", path: "/tmp/child", type: "directory" }],
        },
      },
      {
        type: "workspace-directory-entries-result",
        requestId: "2",
        ok: false,
        errorMessage: "not found",
      },
      { type: "message-port-message", portId: "port-1", data: "hello" },
      { type: "message-port-close", portId: "port-1" },
    ];

    for (const message of messages) {
      expect(isMainToRendererMessage(message)).toBe(true);
      expect(parseMainToRendererMessage(message)).toEqual(message);
    }
  });

  it("rejects invalid fields, duplicate port IDs, oversized collections, and extra fields", () => {
    expect(
      isRendererToMainMessage({
        type: "ipc-renderer-send",
        channel: "test",
        args: [],
        extra: true,
      }),
    ).toBe(false);
    expect(
      isRendererToMainMessage({
        type: "ipc-renderer-post-message",
        channel: "test",
        message: null,
        portIds: ["same", "same"],
      }),
    ).toBe(false);
    expect(
      isRendererToMainMessage({
        type: "ipc-renderer-send",
        channel: "test",
        args: Array.from({ length: IPC_MAX_ARRAY_LENGTH + 1 }),
      }),
    ).toBe(false);
    expect(
      isMainToRendererMessage({
        type: "workspace-directory-entries-result",
        requestId: "1",
        ok: true,
        result: { directoryPath: "/tmp", parentPath: null, entries: [] },
        unexpected: true,
      }),
    ).toBe(false);
  });

  it("keeps the one MiB browser-to-server payload limit", () => {
    expect(() =>
      serializeRendererToMainMessage({
        type: "ipc-renderer-send",
        channel: "test",
        args: ["x".repeat(IPC_MAX_PAYLOAD_BYTES)],
      }),
    ).toThrow("maximum payload size");
  });

  it("allows a bounded large upstream initialization payload to reach the renderer", () => {
    const serialized = serializeMainToRendererMessage({
      type: "ipc-main-event",
      channel: "feature-flags",
      args: ["x".repeat(Math.floor(2.5 * 1024 * 1024))],
    });

    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(
      IPC_MAX_PAYLOAD_BYTES,
    );
    expect(parseMainToRendererMessage(JSON.parse(serialized))).toMatchObject({
      type: "ipc-main-event",
      channel: "feature-flags",
    });
  });

  it("rejects an oversized main-to-renderer payload", () => {
    expect(() =>
      serializeMainToRendererMessage({
        type: "ipc-main-event",
        channel: "feature-flags",
        args: ["x".repeat(IPC_MAX_MAIN_TO_RENDERER_PAYLOAD_BYTES)],
      }),
    ).toThrow("maximum payload size");
  });

  it("permits browser-compatible fields that JSON omits", () => {
    expect(() =>
      serializeRendererToMainMessage({
        type: "ipc-renderer-invoke",
        requestId: "1",
        channel: "test",
        args: [],
        sourceUrl: undefined,
      }),
    ).not.toThrow();
    expect(() =>
      serializeRendererToMainMessage({
        type: "ipc-renderer-post-message",
        channel: "test",
        message: undefined,
        portIds: [],
      }),
    ).not.toThrow();
  });

  it("round-trips an undefined postMessage payload as the compatible omitted wire field", () => {
    const serialized = serializeRendererToMainMessage({
      type: "ipc-renderer-post-message",
      channel: "post",
      message: undefined,
      portIds: [],
    });

    expect(serialized).not.toContain('"message":');
    expect(parseRendererToMainMessage(JSON.parse(serialized))).toEqual({
      type: "ipc-renderer-post-message",
      channel: "post",
      portIds: [],
    });
  });

  it("round-trips an undefined MessagePort payload as the compatible omitted wire field", () => {
    const rendererSerialized = serializeRendererToMainMessage({
      type: "message-port-message",
      portId: "port-undefined",
      data: undefined,
    });
    const mainSerialized = serializeMainToRendererMessage({
      type: "message-port-message",
      portId: "port-undefined",
      data: undefined,
    });

    expect(rendererSerialized).not.toContain('"data":');
    expect(mainSerialized).not.toContain('"data":');
    expect(parseRendererToMainMessage(JSON.parse(rendererSerialized))).toEqual({
      type: "message-port-message",
      portId: "port-undefined",
    });
    expect(parseMainToRendererMessage(JSON.parse(mainSerialized))).toEqual({
      type: "message-port-message",
      portId: "port-undefined",
    });
  });

  it("round-trips an undefined invoke result as the compatible omitted wire field", () => {
    const serialized = serializeMainToRendererMessage({
      type: "ipc-renderer-invoke-result",
      requestId: "undefined",
      ok: true,
      result: undefined,
    });

    expect(serialized).not.toContain('"result":');
    expect(parseMainToRendererMessage(JSON.parse(serialized))).toEqual({
      type: "ipc-renderer-invoke-result",
      requestId: "undefined",
      ok: true,
    });
  });
});

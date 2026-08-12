import { describe, expect, it } from "vitest";
import {
  IPC_MAX_PAYLOAD_BYTES,
  isAllowedIpcOrigin,
  parseRendererToMainMessage,
  parseServerArgs,
} from "./main";

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
  it("rejects malformed and oversized data while accepting a valid envelope", () => {
    expect(parseRendererToMainMessage(Buffer.from("{}"), false)).toBeNull();
    expect(
      parseRendererToMainMessage(
        Buffer.from(
          '{"type":"ipc-renderer-send","channel":"test","args":[],"sourceUrl":"http://localhost"}',
        ),
        false,
      ),
    ).not.toBeNull();
    expect(
      parseRendererToMainMessage(
        Buffer.alloc(IPC_MAX_PAYLOAD_BYTES + 1),
        false,
      ),
    ).toBeNull();
  });
});

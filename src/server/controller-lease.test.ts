import { describe, expect, it } from "vitest";
import {
  CONTROLLER_RECONNECT_GRACE_MS,
  ControllerLeaseManager,
  isSafeReadOnlyIpc,
} from "./controller-lease";

function clock() {
  let current = 1_000;
  return {
    now: () => current,
    advance: (milliseconds: number) => (current += milliseconds),
  };
}

describe("controller lease", () => {
  it("makes the first tab active and keeps the second secondary", () => {
    const time = clock();
    const lease = new ControllerLeaseManager(time.now);
    expect(lease.connect("first")).toBe("active");
    expect(lease.connect("second")).toBe("secondary");
    expect(lease.canMutate("first")).toBe(true);
    expect(lease.canMutate("second")).toBe(false);
  });

  it("allows only reviewed read-only operations from a secondary tab", () => {
    expect(
      isSafeReadOnlyIpc({ type: "workspace-directory-entries-request" }),
    ).toBe(true);
    expect(
      isSafeReadOnlyIpc({
        type: "ipc-renderer-invoke",
        channel: "get-app-version",
      }),
    ).toBe(true);
    expect(
      isSafeReadOnlyIpc({ type: "ipc-renderer-invoke", channel: "unknown" }),
    ).toBe(false);
    expect(
      isSafeReadOnlyIpc({ type: "ipc-renderer-send", channel: "unknown" }),
    ).toBe(false);
  });

  it("has an explicit deterministic takeover", () => {
    const time = clock();
    const lease = new ControllerLeaseManager(time.now);
    lease.connect("first");
    expect(lease.takeControl("second")).toBe("active");
    expect(lease.statusFor("first")).toBe("secondary");
  });

  it("resolves simultaneous take-control messages in arrival order", () => {
    const time = clock();
    const lease = new ControllerLeaseManager(time.now);
    lease.connect("first");
    lease.connect("second");
    lease.takeControl("second");
    lease.takeControl("first");
    expect(lease.statusFor("first")).toBe("active");
    expect(lease.statusFor("second")).toBe("secondary");
  });

  it("expires a stale controller but grants reconnect grace", () => {
    const time = clock();
    const lease = new ControllerLeaseManager(time.now);
    lease.connect("first");
    lease.disconnect("first");
    time.advance(CONTROLLER_RECONNECT_GRACE_MS - 1);
    expect(lease.connect("second")).toBe("secondary");
    expect(lease.connect("first")).toBe("active");
    lease.disconnect("first");
    time.advance(CONTROLLER_RECONNECT_GRACE_MS + 1);
    expect(lease.connect("second")).toBe("active");
  });
});

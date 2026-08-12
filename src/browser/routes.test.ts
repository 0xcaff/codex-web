import { beforeEach, describe, expect, it } from "vitest";
import {
  dispatchNavigateToRoute,
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";

describe("browser route mapping", () => {
  it("maps browser thread paths to memory routes", () => {
    expect(mapBrowserPathToInitialRoute("/thread/plan%20one", "")).toEqual({
      memoryPath: "/local/plan one",
    });
    expect(mapBrowserPathToInitialRoute("/unknown", "")).toEqual({
      memoryPath: "/",
    });
  });

  it("maps malformed percent encoding to the memory root", () => {
    expect(mapBrowserPathToInitialRoute("/thread/%E0%A4%A", "")).toEqual({
      memoryPath: "/",
    });
  });

  it("maps memory routes back to browser paths", () => {
    expect(mapMemoryPathToBrowserPath("/")).toEqual({
      path: "/",
      titleChange: "Codex",
    });
    expect(mapMemoryPathToBrowserPath("/local/plan one")).toEqual({
      path: "/thread/plan%20one",
    });
    expect(mapMemoryPathToBrowserPath("/skills")).toBeNull();
  });
});

describe("share receive routes", () => {
  it("returns the root when the share payload has no supported fields", () => {
    expect(
      mapBrowserPathToInitialRoute("/share/receive", "?source=browser"),
    ).toEqual({
      memoryPath: "/",
      browserPath: "/",
    });
  });

  it("constructs the exact prompt from populated share fields", () => {
    expect(
      mapBrowserPathToInitialRoute(
        "/share/receive",
        "?title=An%20article&text=Read%20this&url=https%3A%2F%2Fexample.com",
      ),
    ).toEqual({
      memoryPath:
        "/?prompt=title%3A+An+article%0Atext%3A+Read+this%0Aurl%3A+https%3A%2F%2Fexample.com",
      browserPath: "/",
    });
  });
});

describe("browser navigation events", () => {
  beforeEach(() => {
    window.history.replaceState(undefined, "", "/");
  });

  it("dispatches the expected message payload", () => {
    const messages: unknown[] = [];
    const listener = (event: MessageEvent) => messages.push(event.data);
    window.addEventListener("message", listener);

    dispatchNavigateToRoute("/local/plan one");

    expect(messages).toEqual([
      {
        type: "navigate-to-route",
        path: "/local/plan one",
      },
    ]);
    window.removeEventListener("message", listener);
  });

  it("dispatches the mapped route on browser history navigation", () => {
    const messages: unknown[] = [];
    const listener = (event: MessageEvent) => messages.push(event.data);
    window.addEventListener("message", listener);
    window.history.replaceState(undefined, "", "/thread/plan%20one");

    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(messages).toEqual([
      {
        type: "navigate-to-route",
        path: "/local/plan one",
      },
    ]);
    window.removeEventListener("message", listener);
  });
});

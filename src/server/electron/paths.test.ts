import { describe, expect, it } from "vitest";
import {
  ElectronPathResolver,
  PINNED_UPSTREAM_GET_PATH_NAMES,
  type ElectronPathEnvironment,
} from "./paths";

function resolver(
  overrides: Partial<ElectronPathEnvironment> = {},
): ElectronPathResolver {
  return new ElectronPathResolver({
    cwd: "/read-only/current-directory",
    env: {},
    homeDir: "/home/codex",
    platform: "linux",
    readFile: () => undefined,
    tempDir: "/tmp",
    ...overrides,
  });
}

describe("ElectronPathResolver", () => {
  it("uses standard macOS paths even when XDG configuration is present", () => {
    const paths = resolver({
      platform: "darwin",
      homeDir: "/Users/codex",
      env: { XDG_CONFIG_HOME: "/state/config" },
      readFile: () =>
        'XDG_DESKTOP_DIR="/incorrect/desktop"\nXDG_DOCUMENTS_DIR="/incorrect/documents"\nXDG_DOWNLOAD_DIR="/incorrect/downloads"\n',
    });

    expect(paths.getPath("home")).toBe("/Users/codex");
    expect(paths.getPath("temp")).toBe("/tmp");
    expect(paths.getPath("crashDumps")).toBe("/tmp/codex-web/crashDumps");
    expect(paths.getPath("userData")).toBe(
      "/Users/codex/Library/Application Support/codex-web",
    );
    expect(paths.getPath("desktop")).toBe("/Users/codex/Desktop");
    expect(paths.getPath("documents")).toBe("/Users/codex/Documents");
    expect(paths.getPath("downloads")).toBe("/Users/codex/Downloads");
  });

  it("uses Linux XDG locations and parses user-dirs.dirs", () => {
    const paths = resolver({
      env: { XDG_CONFIG_HOME: "/state/config" },
      readFile: (filePath) =>
        filePath === "/state/config/user-dirs.dirs"
          ? 'XDG_DESKTOP_DIR="$HOME/Desk"\nXDG_DOCUMENTS_DIR="/state/docs"\nXDG_DOWNLOAD_DIR="relative-downloads"\n'
          : undefined,
    });

    expect(paths.getPath("userData")).toBe("/state/config/codex-web");
    expect(paths.getPath("desktop")).toBe("/home/codex/Desk");
    expect(paths.getPath("documents")).toBe("/state/docs");
    expect(paths.getPath("downloads")).toBe("/home/codex/relative-downloads");
  });

  it("uses home-directory defaults when XDG user directories are missing", () => {
    const paths = resolver();

    expect(paths.getPath("userData")).toBe("/home/codex/.config/codex-web");
    expect(paths.getPath("desktop")).toBe("/home/codex/Desktop");
    expect(paths.getPath("documents")).toBe("/home/codex/Documents");
    expect(paths.getPath("downloads")).toBe("/home/codex/Downloads");
  });

  it("ignores relative XDG_CONFIG_HOME values", () => {
    const paths = resolver({ env: { XDG_CONFIG_HOME: "relative/config" } });

    expect(paths.getPath("appData")).toBe("/home/codex/.config");
    expect(paths.getPath("userData")).toBe("/home/codex/.config/codex-web");
  });

  it("honours absolute setPath overrides and rejects relative paths", () => {
    const paths = resolver();

    paths.setPath("userData", "/state/custom-codex-web");
    expect(paths.getPath("userData")).toBe("/state/custom-codex-web");
    paths.setPath("crashDumps", "/state/crash-dumps");
    expect(paths.getPath("crashDumps")).toBe("/state/crash-dumps");
    expect(() => paths.setPath("userData", "relative-state")).toThrow(
      "absolute",
    );
  });

  it("supports every app.getPath name consumed by the pinned upstream bundle", () => {
    const paths = resolver();
    for (const name of PINNED_UPSTREAM_GET_PATH_NAMES) {
      expect(paths.getPath(name)).toEqual(expect.any(String));
    }
  });

  it("does not use a read-only cwd and rejects unknown paths", () => {
    const paths = resolver();

    expect(paths.getPath("downloads")).toBe("/home/codex/Downloads");
    expect(() => paths.getPath("upstream-unknown-path")).toThrow("Unsupported");
  });
});

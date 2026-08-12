import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("check:versions", () => {
  it("reports a fixture mismatch with an actionable path", async () => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "codex-web-version-check-"),
    );
    temporaryRoots.push(fixtureRoot);
    await Promise.all([
      cp(
        path.join(root, "compatibility.json"),
        path.join(fixtureRoot, "compatibility.json"),
      ),
      cp(
        path.join(root, "package-lock.json"),
        path.join(fixtureRoot, "package-lock.json"),
      ),
      cp(path.join(root, "default.nix"), path.join(fixtureRoot, "default.nix")),
      cp(
        path.join(root, "vite.browser.config.ts"),
        path.join(fixtureRoot, "vite.browser.config.ts"),
      ),
      cp(path.join(root, "nix"), path.join(fixtureRoot, "nix"), {
        recursive: true,
      }),
      cp(path.join(root, "scripts"), path.join(fixtureRoot, "scripts"), {
        recursive: true,
      }),
      cp(path.join(root, "src"), path.join(fixtureRoot, "src"), {
        recursive: true,
      }),
    ]);
    const packageJson = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    packageJson.version = "mismatched-version";
    await writeFile(
      path.join(fixtureRoot, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );

    await expect(
      execFileAsync(
        "node",
        ["scripts/check_versions.mjs", "--root", fixtureRoot],
        {
          cwd: root,
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("package.json version"),
    });
  });
});

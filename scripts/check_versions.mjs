#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootArgumentIndex = process.argv.indexOf("--root");
const root =
  rootArgumentIndex === -1
    ? path.resolve(scriptDir, "..")
    : path.resolve(process.argv[rootArgumentIndex + 1] ?? "");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

const manifest = readJson("compatibility.json");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const failures = [];

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
    );
  }
}

function expectIncludes(relativePath, text) {
  if (!readText(relativePath).includes(text)) {
    failures.push(`${relativePath}: expected to consume ${text}`);
  }
}

expectEqual(
  "package.json version",
  packageJson.version,
  manifest.project.version,
);
expectEqual(
  "package-lock root version",
  packageLock.packages?.[""]?.version,
  manifest.project.version,
);
expectEqual(
  "package.json better-sqlite3",
  packageJson.dependencies?.["better-sqlite3"],
  `^${manifest.nativeAddon.betterSqlite3Version}`,
);
expectEqual(
  "package-lock root better-sqlite3",
  packageLock.packages?.[""]?.dependencies?.["better-sqlite3"],
  `^${manifest.nativeAddon.betterSqlite3Version}`,
);
expectEqual(
  "package-lock installed better-sqlite3",
  packageLock.packages?.["node_modules/better-sqlite3"]?.version,
  manifest.nativeAddon.betterSqlite3Version,
);
expectEqual(
  "package.json electron",
  packageJson.devDependencies?.electron,
  manifest.electronEmulation.version,
);
expectEqual(
  "package-lock root electron",
  packageLock.packages?.[""]?.devDependencies?.electron,
  manifest.electronEmulation.version,
);
expectEqual(
  "package-lock installed electron",
  packageLock.packages?.["node_modules/electron"]?.version,
  manifest.electronEmulation.version,
);

expectIncludes("default.nix", "compatibility = builtins.fromJSON");
expectIncludes("default.nix", "compatibility.desktop.version");
expectIncludes("default.nix", "compatibility.desktop.archive.sha256");
expectIncludes("default.nix", "compatibility.nativeAddon.betterSqlite3Version");
expectIncludes("default.nix", "compatibility.project.version");
expectIncludes("nix/codex/default.nix", "compatibility = builtins.fromJSON");
expectIncludes("nix/codex/default.nix", "compatibility.codexCli.version");
expectIncludes(
  "nix/codex/default.nix",
  "compatibility.codexCli.platforms.${system}",
);
expectIncludes("scripts/prepare", "desktop.version");
expectIncludes("scripts/prepare", "desktop.archive.sha256");
expectIncludes("vite.browser.config.ts", "compatibility.desktop.version");
expectIncludes(
  "vite.browser.config.ts",
  "compatibility.electronEmulation.version",
);
expectIncludes(
  "src/server/bootstrap.ts",
  "compatibilityManifest.electronEmulation.version",
);
expectIncludes(
  "src/server/electron/index.ts",
  "compatibilityManifest.desktop.version",
);
expectIncludes("src/browser/shim.ts", "__ELECTRON_EMULATION_VERSION__");

if (failures.length > 0) {
  console.error(
    "Compatibility version check failed:\n" +
      failures.map((failure) => `- ${failure}`).join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log("Compatibility versions are synchronized.");
}

import path from "node:path";
import { glob } from "glob";
import compatibilityManifest from "../../compatibility.json";
import { installModuleAliasHook } from "./module";

declare global {
  var __CODEX_SHIM_VALUES__: { version: string };
}

export function ensureElectronLikeProcessContext(): void {
  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron)
    Object.defineProperty(versions, "electron", {
      value: compatibilityManifest.electronEmulation.version,
      configurable: true,
      enumerable: true,
      writable: false,
    });
  const processWithElectronFields = process as NodeJS.Process & {
    resourcesPath?: string;
    type?: string;
  };
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

export async function bootstrapMainApp(): Promise<void> {
  ensureElectronLikeProcessContext();
  installModuleAliasHook();
  globalThis.__CODEX_SHIM_VALUES__ = {
    version: compatibilityManifest.desktop.version,
  };
  const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
    nodir: true,
    cwd: __dirname,
  });
  if (matches.length === 0) throw new Error("no main bundle found");
  if (matches.length > 1) throw new Error("multiple main bundles found");
  const mainModule = require(matches[0]!) as {
    runMainAppStartup: () => Promise<void> | void;
  };
  await mainModule.runMainAppStartup();
}

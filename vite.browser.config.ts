import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const asarPackagePath = path.resolve(configDir, "scratch/asar/package.json");
const webviewRoot = path.resolve(configDir, "scratch/asar/webview");
const preloadEntryPath = path.resolve(
  configDir,
  "scratch/asar/.vite/build/preload.js",
);
const browserNodeEnv = process.env.NODE_ENV ?? "production";
const asarPackageJson = JSON.parse(readFileSync(asarPackagePath, "utf8")) as {
  version?: unknown;
};

if (typeof asarPackageJson.version !== "string" || !asarPackageJson.version) {
  throw new Error(`Expected a version string in ${asarPackagePath}`);
}

export default defineConfig({
  root: webviewRoot,
  define: {
    __CODEX_APP_VERSION__: JSON.stringify(asarPackageJson.version),
    "process.env.NODE_ENV": JSON.stringify(browserNodeEnv),
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/__backend/ipc": {
        target: `ws://127.0.0.1:8214`,
        changeOrigin: true,
        ws: true,
      },
      "/__backend/upload": {
        target: `http://127.0.0.1:8214`,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      electron: path.resolve(configDir, "src/browser/shim.ts"),
    },
  },
  build: {
    commonjsOptions: {
      include: [/scratch\/asar\/\.vite\/build\/preload\.js/, /node_modules/],
      requireReturnsDefault: "auto",
      transformMixedEsModules: true,
    },
    emptyOutDir: false,
    minify: false,
    outDir: path.resolve(webviewRoot, "assets"),
    sourcemap: true,
    lib: {
      entry: preloadEntryPath,
      fileName: () => "preload.js",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "preload.js",
      },
    },
  },
});

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type HtmlTagDescriptor, type PluginOption } from "vite";
import { createHtmlPlugin } from "vite-plugin-html";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const asarPackagePath = path.resolve(configDir, "scratch/asar/package.json");
const webviewRoot = path.resolve(configDir, "scratch/asar/webview");
const browserBuildOutDir = path.resolve(webviewRoot, ".codex-web-build");
const preloadEntryPath = path.resolve(
  configDir,
  "scratch/asar/.vite/build/preload.js",
);
const preloadEntryHtmlPath = path
  .relative(webviewRoot, preloadEntryPath)
  .split(path.sep)
  .join("/");
const browserNodeEnv = process.env.NODE_ENV ?? "production";
const asarPackageJson = JSON.parse(readFileSync(asarPackagePath, "utf8")) as {
  version?: unknown;
};

if (typeof asarPackageJson.version !== "string" || !asarPackageJson.version) {
  throw new Error(`Expected a version string in ${asarPackagePath}`);
}

const codexWebStyleOverride =
  ".main-surface { --spacing-token-safe-header-left: 0px; }";

const codexHtmlTags: HtmlTagDescriptor[] = [
  {
    tag: "base",
    attrs: {
      href: "/",
    },
    injectTo: "head-prepend",
  },
  {
    tag: "script",
    attrs: {
      type: "module",
      src: preloadEntryHtmlPath,
    },
    injectTo: "head-prepend",
  },
  {
    tag: "link",
    attrs: {
      rel: "icon",
      type: "image/svg+xml",
      href: "./favicon.svg",
    },
    injectTo: "head",
  },
  {
    tag: "link",
    attrs: {
      rel: "manifest",
      href: "./manifest.json",
    },
    injectTo: "head",
  },
  {
    tag: "style",
    children: codexWebStyleOverride,
    injectTo: "head",
  },
];

function addViteIgnoreToUpstreamAssetTags(html: string): string {
  return html
    .replace(
      /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']\.\/assets\/)(?![^>]*\bvite-ignore\b)[^>]*>/gi,
      addViteIgnoreAttribute,
    )
    .replace(
      /<link\b(?=[^>]*\brel=["'](?:modulepreload|stylesheet)["'])(?=[^>]*\bhref=["']\.\/assets\/)(?![^>]*\bvite-ignore\b)[^>]*>/gi,
      addViteIgnoreAttribute,
    );
}

function addViteIgnoreAttribute(tag: string): string {
  return tag.endsWith("/>")
    ? tag.replace(/\s*\/>$/, " vite-ignore />")
    : tag.replace(/>$/, " vite-ignore>");
}

function prepareIndexHtml(html: string): string {
  const withoutLegacyPatches = html
    .replace(/\s*<!-- PROD_BASE_TAG_HERE -->/g, "")
    .replace(/\s*<!-- PROD_CSP_TAG_HERE -->/g, "")
    .replace(/\s*<base\s+href=["']\/["']\s*\/?>/gi, "")
    .replace(
      /\s*<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
      "",
    )
    .replace(
      /\s*<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["'][^"']*\/?assets\/preload(?:-[^"']+)?\.js[^"']*["'])[^>]*>\s*<\/script>/gi,
      "",
    )
    .replace(
      /\s*<link\b(?=[^>]*\brel=["']icon["'])(?=[^>]*\bhref=["'][^"']*favicon(?:-[^"']+)?\.svg[^"']*["'])[^>]*>/gi,
      "",
    )
    .replace(
      /\s*<link\b(?=[^>]*\brel=["']manifest["'])(?=[^>]*\bhref=["'][^"']*manifest(?:-[^"']+)?\.json[^"']*["'])[^>]*>/gi,
      "",
    )
    .replace(
      /\s*<style>\s*\.main-surface\s*\{\s*--spacing-token-safe-header-left:\s*0px;\s*\}\s*<\/style>/gi,
      "",
    );

  return addViteIgnoreToUpstreamAssetTags(withoutLegacyPatches);
}

function codexIndexHtmlPlugin(): PluginOption {
  return {
    name: "codex-web:index-html",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return prepareIndexHtml(html);
      },
    },
  };
}

function entryFileNames(chunkInfo: { facadeModuleId: string | null }): string {
  if (chunkInfo.facadeModuleId === path.resolve(webviewRoot, "index.html")) {
    return "assets/preload-[hash].js";
  }
  return "assets/[name]-[hash].js";
}

const generatedAssetPatterns = [
  /^favicon-[A-Za-z0-9_-]{8,}\.svg$/,
  /^manifest-[A-Za-z0-9_-]{8,}\.json$/,
  /^preload-[A-Za-z0-9_-]{8,}\.js(?:\.map)?$/,
];

function isGeneratedBrowserAsset(filename: string): boolean {
  return generatedAssetPatterns.some((pattern) => pattern.test(filename));
}

async function removePreviousGeneratedBrowserAssets(): Promise<void> {
  const webviewAssetsDir = path.resolve(webviewRoot, "assets");
  const entries = await fs.readdir(webviewAssetsDir).catch(() => []);

  await Promise.all(
    entries
      .filter(isGeneratedBrowserAsset)
      .map((entry) =>
        fs.rm(path.join(webviewAssetsDir, entry), { force: true }),
      ),
  );
}

function copyBrowserBuildPlugin(): PluginOption {
  return {
    name: "codex-web:copy-browser-build",
    async closeBundle() {
      const webviewAssetsDir = path.resolve(webviewRoot, "assets");
      const buildAssetsDir = path.resolve(browserBuildOutDir, "assets");

      await removePreviousGeneratedBrowserAssets();
      await fs.copyFile(
        path.resolve(browserBuildOutDir, "index.html"),
        path.resolve(webviewRoot, "index.html"),
      );
      await fs.mkdir(webviewAssetsDir, { recursive: true });

      for (const entry of await fs.readdir(buildAssetsDir)) {
        await fs.copyFile(
          path.join(buildAssetsDir, entry),
          path.join(webviewAssetsDir, entry),
        );
      }

      await fs.rm(browserBuildOutDir, { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  root: webviewRoot,
  plugins: [
    codexIndexHtmlPlugin(),
    createHtmlPlugin({
      minify: false,
      inject: {
        tags: codexHtmlTags,
      },
    }),
    copyBrowserBuildPlugin(),
  ],
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
    assetsDir: "assets",
    commonjsOptions: {
      include: [/scratch\/asar\/\.vite\/build\/preload\.js/, /node_modules/],
      requireReturnsDefault: "auto",
      transformMixedEsModules: true,
    },
    emptyOutDir: true,
    minify: false,
    outDir: browserBuildOutDir,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(webviewRoot, "index.html"),
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames,
      },
    },
  },
});

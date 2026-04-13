import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: "scratch/asar/webview/assets",
    sourcemap: true,
    lib: {
      entry: "src/bridge/index.ts",
      fileName: () => "dev-bridge.js",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "dev-bridge.js",
      },
    },
  },
});

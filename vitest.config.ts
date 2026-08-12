import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: [
      "src/browser/**/*.test.ts",
      "src/server/**/*.test.ts",
      "src/shared/**/*.test.ts",
    ],
  },
});

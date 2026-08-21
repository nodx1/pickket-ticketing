import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    globals: true,
    css: false,
  },
  resolve: {
    alias: {
      "@pickket/lib/utils": path.resolve(__dirname, "../lib/src/utils.ts"),
      "@pickket/lib/hooks": path.resolve(__dirname, "../lib/src/hooks/index.ts"),
      "@pickket/lib": path.resolve(__dirname, "../lib/src/index.ts"),
    },
  },
});

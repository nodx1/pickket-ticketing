import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
  },
  resolve: {
    alias: {
      "@pickket/store": path.resolve(__dirname, "../store/src/index.ts"),
    },
  },
});

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    globals: true,
    css: false,
    exclude: ["**/e2e/**", "**/node_modules/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // next/web-vitals는 Next.js 빌드 전용 모듈 — vitest 환경에서는 빈 stub으로 처리
      "next/web-vitals": path.resolve(__dirname, "../../packages/lib/src/__mocks__/next-web-vitals.ts"),
    },
  },
});

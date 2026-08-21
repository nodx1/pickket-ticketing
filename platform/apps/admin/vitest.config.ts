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
      // next-intl은 NextIntlClientProvider 컨텍스트가 필요 — vitest에서 stub으로 처리
      "next-intl": path.resolve(__dirname, "../../packages/lib/src/__mocks__/next-intl.ts"),
      "@pickket/lib/api": path.resolve(__dirname, "../../packages/lib/src/api.ts"),
      "@pickket/lib/domain-config": path.resolve(__dirname, "../../packages/lib/src/domain-config.ts"),
      "@pickket/lib/hooks": path.resolve(__dirname, "../../packages/lib/src/hooks/index.ts"),
      "@pickket/lib/utils": path.resolve(__dirname, "../../packages/lib/src/utils.ts"),
      "@pickket/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
      "@pickket/lib": path.resolve(__dirname, "../../packages/lib/src/index.ts"),
      "@pickket/store": path.resolve(__dirname, "../../packages/store/src/index.ts"),
      "react": path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },
});

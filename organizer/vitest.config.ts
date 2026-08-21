import { defineConfig } from "vitest/config";
import path from "path";

/**
 * 서버 provider·순수 유닛 테스트(기본 node 환경) + **컴포넌트 렌더 테스트**.
 * e2e(specs/)는 Playwright 담당 → 제외.
 *
 * ## 🔴 `.tsx` 를 왜 이제야 넣나 (2026-08-02)
 * `include` 가 `.ts` 뿐이라 **컴포넌트 테스트가 수집조차 되지 않았다.**
 * 실제로 `.tsx` 테스트를 만들었더니 `No test files found` 가 떴고, 그때까지
 * 이 리포에는 **React 렌더 테스트가 한 건도 없었다.** 그래서 화면 결함이
 * 전부 실물 크롤로만 발견됐다(2026-08-01 하루에 5건).
 *
 * ## ⚠️ 기본 환경은 여전히 `node` 다
 * 241개 기존 테스트가 서버 코드(node:crypto·fs·pg)를 쓴다. 전역을 jsdom 으로 바꾸면
 * 그쪽이 깨진다. 렌더가 필요한 파일만 **파일 첫 줄에** 선언한다:
 *
 *     // @vitest-environment jsdom
 *
 * 이렇게 하면 기존 테스트는 **한 줄도 안 건드린다.**
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["specs/**", "node_modules/**", ".next/**"],
    setupFiles: ["src/test/setup-dom.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

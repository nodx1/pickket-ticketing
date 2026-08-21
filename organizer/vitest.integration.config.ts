import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * 통합테스트 전용 설정 (T8).
 *
 * 기본 게이트(`vitest.config.ts`)와 **분리**한다:
 *   · 기본 게이트는 hermetic 이어야 한다(외부 의존 0) — CI/훅에서 무조건 돌아야 하므로.
 *   · 이 설정은 **실 PostgreSQL 이 있어야만** 돈다. 없으면 즉시 실패시킨다(조용한 skip 금지 —
 *     "통과했다"고 오인되면 검증 공백이 다시 생긴다).
 *
 * 실행:  bash scripts/itest-db.sh up && eval "$(bash scripts/itest-db.sh env)" && npm run test:integration
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.itest.ts"],
    setupFiles: ["src/test/itest-setup.ts"],
    // 같은 DB 를 공유하므로 파일 간 병렬 실행을 막는다(테이블 TRUNCATE 가 서로를 지운다).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});

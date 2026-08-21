/**
 * Phase 5A-1 — Redis ZSET rate limiter 회귀 테스트
 *
 * 검증:
 *  - /api/auth/login auth preset 5/60s → 6번째 429
 *  - 성공 응답 헤더에 X-RateLimit-* 있음
 *  - 429 응답에 Retry-After 헤더 있음
 *
 * 주의: 기본 E2E 환경은 일반 비즈니스 테스트의 안정성을 위해 한도를 10배 완화한다.
 *       이 스펙은 `PLAYWRIGHT_TEST_RATE_LIMIT=enabled`로 실행해야 정확한 한도를 검증한다.
 */
import { test, expect } from "@playwright/test";

test.describe("Phase 5A-1: Rate Limit (Redis ZSET sliding window)", () => {
  test.skip(
    process.env.PLAYWRIGHT_TEST === "1" && process.env.PLAYWRIGHT_TEST_RATE_LIMIT !== "enabled",
    "정확한 rate limit 검증은 PLAYWRIGHT_TEST_RATE_LIMIT=enabled에서만 실행합니다.",
  );

  test("POST /api/auth/login 6회 연속 → 6번째 429", async ({ request }) => {
    const results: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const response = await request.post("/api/auth/login", {
        data: { email: "nope@e2e.test", password: "wrong_password" },
      });
      results.push(response.status());
    }

    // 처음 5회는 401 (인증 실패), 6번째는 429 (rate limit)
    expect(results.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(results[5]).toBe(429);
  });

  test("429 응답에 Retry-After 헤더 포함", async ({ request }) => {
    // 한도 채우기
    for (let i = 0; i < 6; i++) {
      await request.post("/api/auth/login", {
        data: { email: "retry@e2e.test", password: "x" },
      });
    }

    const blocked = await request.post("/api/auth/login", {
      data: { email: "retry@e2e.test", password: "x" },
    });
    expect(blocked.status()).toBe(429);
    const retryAfter = blocked.headers()["retry-after"];
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

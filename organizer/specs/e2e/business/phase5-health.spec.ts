/**
 * Phase 5C-2 — 헬스체크 3종 회귀 테스트
 *
 * 검증:
 *  - /api/health (legacy) → 200 success
 *  - /api/health/live → 200 alive (외부 의존성 없이)
 *  - /api/health/ready → 200 ready + DB/Redis latency 포함
 *  - ready는 DB/Redis 장애 시 503 반환해야 함 (정상 시에만 테스트)
 */
import { expect, test } from "@playwright/test";

test.describe("Phase 5C-2: 헬스체크 엔드포인트", () => {
  test("GET /api/health/live → 200 alive (외부 의존성 없음)", async ({ request }) => {
    const response = await request.get("/api/health/live");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("alive");
    expect(body.timestamp).toBeTruthy();
  });

  test("GET /api/health/ready → 200 ready + DB/Redis checks", async ({ request }) => {
    const response = await request.get("/api/health/ready");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ready");
    expect(body.checks).toBeTruthy();
    expect(body.checks.db).toBeTruthy();
    expect(body.checks.db.ok).toBe(true);
    expect(typeof body.checks.db.latencyMs).toBe("number");
    expect(body.checks.redis).toBeTruthy();
    expect(body.checks.redis.ok).toBe(true);
  });

  test("GET /api/health (legacy) → 하위호환 유지", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ok");
  });

  test("헬스체크 응답 시간이 1초 이내", async ({ request }) => {
    const start = Date.now();
    await request.get("/api/health/ready");
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1000);
  });
});

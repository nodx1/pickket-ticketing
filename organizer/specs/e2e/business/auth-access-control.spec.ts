/**
 * 인증 & 접근 제어 테스트
 * - 비인증 요청 차단
 * - 잘못된 인증 차단
 * - 주요 엔드포인트 인증 요구 확인
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

let request: APIRequestContext;

test.describe("인증 & 접근 제어", () => {
  test.beforeAll(async ({ playwright }) => {
    // 로그인하지 않은 컨텍스트
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  // ── 비인증 요청 차단 ──────────────────────────────────────────

  test("1. 비인증 → GET /api/events → 401", async () => {
    const res = await request.get("/api/events");
    expect(res.status()).toBe(401);
  });

  test("2. 비인증 → GET /api/dashboard → 401", async () => {
    const res = await request.get("/api/dashboard");
    expect(res.status()).toBe(401);
  });

  test("3. 비인증 → GET /api/notifications → 401", async () => {
    const res = await request.get("/api/notifications");
    expect(res.status()).toBe(401);
  });

  test("4. 비인증 → GET /api/auth/me → 401", async () => {
    const res = await request.get("/api/auth/me");
    expect(res.status()).toBe(401);
  });

  test("5. 비인증 → GET /api/account/settlements → 401", async () => {
    const res = await request.get("/api/account/settlements");
    expect(res.status()).toBe(401);
  });

  test("6. 비인증 → POST /api/events → 401", async () => {
    const res = await request.post("/api/events", {
      data: { title: "해킹 시도" },
    });
    expect(res.status()).toBe(401);
  });

  test("7. 비인증 → GET /api/admin/audit-logs → 401", async () => {
    const res = await request.get("/api/admin/audit-logs");
    expect(res.status()).toBe(401);
  });

  // ── 잘못된 인증 ──────────────────────────────────────────────

  test("8. 잘못된 비밀번호 → 로그인 실패", async () => {
    // ⚠️ 공유 시드 계정(demo@pickket.kr)에 오답을 넣지 않는다 — v2 인증은 계정단위
    // 잠금(brute-force 방어)이라, 공유 계정을 오답으로 때리면 잠겨서 이후 모든 인증
    // 테스트가 429("Account temporarily locked")로 연쇄 실패한다. 일회용 이메일 사용
    // (v2 는 anti-enumeration 으로 미존재/오답 모두 동일하게 401 → 단언 동일).
    const res = await request.post("/api/auth/login", {
      data: { email: `wrongpass-probe-${Date.now()}@pickket-test.kr`, password: "wrongpassword" },
    });
    expect(res.status()).toBe(401);
  });

  test("9. 존재하지 않는 이메일 → 로그인 실패", async () => {
    const res = await request.post("/api/auth/login", {
      data: { email: "nonexist@pickket.kr", password: "password123" },
    });
    expect(res.status()).toBe(401);
  });

  test("10. 빈 바디로 로그인 → 400", async () => {
    const res = await request.post("/api/auth/login", { data: {} });
    expect(res.status()).toBe(400);
  });

  // ── 공개 API는 비인증 허용 ────────────────────────────────────

  test("11. 공개 API → GET /sitemap.xml → 비인증 허용", async () => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
  });

  test("12. 공개 API → GET /api/health → 200", async () => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
  });

  test("13. 공개 API → POST /api/checkout/initiate는 인증 불필요", async () => {
    // 잘못된 데이터지만 401이 아니어야 함 (인증 필요 없는 엔드포인트)
    const res = await request.post("/api/checkout/initiate", {
      data: { eventId: "invalid" },
    });
    // 400 (검증 실패) 또는 다른 에러이지 401이 아님
    expect(res.status()).not.toBe(401);
  });

  // ── CSRF / 보안 헤더 ─────────────────────────────────────────

  test("14. API 응답에 보안 헤더 존재", async () => {
    const res = await request.get("/api/health");
    const headers = res.headers();
    // X-Content-Type-Options
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  // ── 인증 후 정상 접근 ─────────────────────────────────────────

  test("15. 인증 후 → GET /api/events → 200", async ({ playwright }) => {
    const authReq = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const loginRes = await authReq.post("/api/auth/login", {
      data: { email: "demo@pickket.kr", password: "Test1234!" },
    });
    expect(loginRes.ok()).toBeTruthy();

    const res = await authReq.get("/api/events");
    expect(res.status()).toBe(200);
    await authReq.dispose();
  });

  test("16. 로그아웃 후 → 다시 401", async ({ playwright }) => {
    const authReq = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await authReq.post("/api/auth/login", {
      data: { email: "demo@pickket.kr", password: "Test1234!" },
    });

    // 로그아웃
    const logoutRes = await authReq.post("/api/auth/logout");
    expect(logoutRes.status()).toBe(200);

    // 로그아웃 후 보호 API 접근
    const res = await authReq.get("/api/events");
    expect(res.status()).toBe(401);
    await authReq.dispose();
  });
});

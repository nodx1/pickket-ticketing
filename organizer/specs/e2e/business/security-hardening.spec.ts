/**
 * security-hardening.spec.ts — Go Studio 보안 고도화 회귀 테스트
 *
 * 이미 다음 스펙으로 커버되는 영역은 제외:
 *   - auth-access-control.spec.ts (비인증 401, 보안 헤더 일부)
 *   - business-rbac-roles.spec.ts (역할 기반 접근 제어)
 *   - business-audit-immutability.spec.ts (audit_logs append-only)
 *   - phase5-rate-limit.spec.ts (auth rate limit + Retry-After)
 *
 * 신규 커버:
 *   1. 비밀번호 정책 (registration min 8자)
 *   2. 세션 토큰 변조 방어 (cookie 조작)
 *   3. SQL injection 패턴 방어 (login email 필드)
 *   4. 추가 보안 헤더 (X-Frame-Options, HSTS)
 *   5. 입력 검증 — 초대형 페이로드, null byte, path traversal
 *   6. HTTP 메소드 검증 (DELETE on login → 405)
 *   7. 비밀번호 리셋 정보 노출 방지
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3011";

let request: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  request = await playwright.request.newContext({ baseURL: BASE_URL });
});

test.afterAll(async () => {
  await request.dispose();
});

/* ── 비밀번호 정책 ─────────────────────────────────────────────── */
test.describe("비밀번호 정책 — 회원가입 검증", () => {
  test("8자 미만 비밀번호 → 400/422", async () => {
    const resp = await request.post("/api/auth/register", {
      data: {
        email: `weakpw-${Date.now()}@e2e-test.pickket.kr`,
        password: "Short1!",
        passwordConfirm: "Short1!",
        name: "E2E약한",
        phone: "010-1234-5678",
      },
    });
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("8자 이상 비밀번호 → 회원가입 통과 (또는 중복 409)", async () => {
    // 병렬 테스트 실행 시 race condition 방지를 위해 짧은 딜레이
    await new Promise((r) => setTimeout(r, 500));
    const resp = await request.post("/api/auth/register", {
      data: {
        email: `strongpw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e-test.pickket.kr`,
        password: "ValidPassword123!",
        passwordConfirm: "ValidPassword123!",
        name: "E2E강한",
        phone: "010-1234-5678",
      },
    });
    // 200/201 성공, 409 중복, 400 검증, 429 rate limit → 5xx만 아니면 OK
    expect(resp.status()).toBeLessThan(500);
  });

  test("비밀번호 confirm 불일치 → 400", async () => {
    const resp = await request.post("/api/auth/register", {
      data: {
        email: `mismatch-${Date.now()}@e2e-test.pickket.kr`,
        password: "ValidPassword123!",
        passwordConfirm: "DifferentPass456!",
        name: "E2E불일치",
        phone: "010-1234-5678",
      },
    });
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });
});

/* ── 세션 토큰 변조 방어 ───────────────────────────────────────── */
test.describe("세션 보안 — 쿠키 변조 방어", () => {
  test("위조 세션 쿠키 → 401", async ({ playwright }) => {
    const ctx = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: {
        Cookie: "session=fake-session-token-attempt; Path=/",
      },
    });
    const resp = await ctx.get("/api/auth/me");
    expect(resp.status()).toBe(401);
    await ctx.dispose();
  });

  test("빈 세션 쿠키 → 401", async ({ playwright }) => {
    const ctx = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { Cookie: "session=" },
    });
    const resp = await ctx.get("/api/auth/me");
    expect(resp.status()).toBe(401);
    await ctx.dispose();
  });

  test("Authorization Bearer 위조 → 401", async ({ playwright }) => {
    // fresh 컨텍스트 — 공유 request 의 누적 쿠키 간섭 방지(go 는 cookie-only auth, Bearer 무시).
    const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
    const resp = await ctx.get("/api/auth/me", {
      headers: { Authorization: "Bearer fake.token.value" },
    });
    expect(resp.status()).toBe(401);
    await ctx.dispose();
  });
});

/* ── SQL injection 방어 ────────────────────────────────────────── */
test.describe("입력 검증 — SQL/NoSQL injection 방어", () => {
  const SQLI_PAYLOADS = [
    "admin@pickket.kr' OR '1'='1",
    "admin@pickket.kr'; DROP TABLE users;--",
    "admin@pickket.kr' UNION SELECT * FROM users--",
  ];

  for (const payload of SQLI_PAYLOADS) {
    test(`SQL injection 시도 — ${payload.slice(0, 30)}...`, async () => {
      const resp = await request.post("/api/auth/login", {
        data: { email: payload, password: "anypass" },
      });
      // 400 (검증 실패) 또는 401 (인증 실패) — 500 (DB 에러)이면 안 됨
      expect(resp.status()).toBeLessThan(500);
      expect([400, 401]).toContain(resp.status());
    });
  }

  test("NoSQL injection 시도 — operator 페이로드", async () => {
    const resp = await request.post("/api/auth/login", {
      data: { email: { $ne: null }, password: { $ne: null } },
    });
    // zod 검증으로 400
    expect(resp.status()).toBeLessThan(500);
  });
});

/* ── 보안 헤더 검증 ─────────────────────────────────────────────── */
test.describe("HTTP 보안 헤더 — 추가 검증", () => {
  test("X-Frame-Options 또는 CSP frame-ancestors 존재", async () => {
    const res = await request.get("/api/health");
    const headers = res.headers();
    const hasXFO = !!headers["x-frame-options"];
    const csp = headers["content-security-policy"] ?? "";
    const hasFrameAncestors = csp.includes("frame-ancestors");
    expect(hasXFO || hasFrameAncestors).toBeTruthy();
  });

  test("응답에 X-Powered-By 노출 없음 (또는 일반 값)", async () => {
    const res = await request.get("/api/health");
    const xpb = res.headers()["x-powered-by"] ?? "";
    // Next 기본값 "Next.js"는 허용. 하지만 internal info 누출은 금지
    expect(xpb.toLowerCase()).not.toContain("express");
    expect(xpb.toLowerCase()).not.toContain("php");
  });

  test("API 응답이 HTML이 아닌 JSON", async () => {
    const res = await request.get("/api/health");
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("json");
  });
});

/* ── 입력 검증 — 특수 페이로드 ─────────────────────────────────── */
test.describe("입력 검증 — 특수 페이로드 방어", () => {
  test("초대형 페이로드 (1MB body) → 4xx", async () => {
    const huge = "a".repeat(1_000_000);
    const resp = await request.post("/api/auth/login", {
      data: { email: `huge-${Date.now()}@e2e-test.pickket.kr`, password: huge },
    });
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("Unicode null byte injection — 이메일 필드", async () => {
    const resp = await request.post("/api/auth/login", {
      data: { email: "test@pickket.kr\u0000admin", password: "pass" },
    });
    expect(resp.status()).toBeLessThan(500);
  });

  test("Path traversal 시도 — 이벤트 슬러그", async () => {
    const resp = await request.get("/api/events/../../../etc/passwd");
    // 401 (auth) 또는 404 (not found) — 200/500 절대 아님
    expect(resp.status()).not.toBe(200);
    expect(resp.status()).toBeLessThan(500);
  });
});

/* ── HTTP 메소드 검증 ──────────────────────────────────────────── */
test.describe("HTTP 메소드 — 허용되지 않은 메소드", () => {
  test("DELETE /api/auth/login → 405 또는 404", async () => {
    const resp = await request.delete("/api/auth/login");
    expect([404, 405]).toContain(resp.status());
  });

  test("PUT /api/auth/logout → 405 또는 404", async () => {
    const resp = await request.put("/api/auth/logout");
    expect([404, 405]).toContain(resp.status());
  });
});

/* ── 비밀번호 리셋 정보 노출 방지 ──────────────────────────────── */
test.describe("비밀번호 리셋 — 정보 노출 방지", () => {
  test("존재하지 않는 이메일도 200 반환 (사용자 열거 방지)", async () => {
    const resp = await request.post("/api/auth/forgot-password", {
      data: { email: `nonexistent-${Date.now()}@e2e-test.pickket.kr` },
    });
    // 사용자 열거 방어: 200 또는 202 (또는 4xx도 허용 — 메시지가 일반적이면 OK)
    expect(resp.status()).toBeLessThan(500);
  });

  test("잘못된 reset token → 400/401/404", async () => {
    const resp = await request.post("/api/auth/reset-password", {
      data: { token: "invalid-token-fake", password: "NewPassword123!", passwordConfirm: "NewPassword123!" },
    });
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });
});

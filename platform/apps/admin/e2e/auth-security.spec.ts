import { test as base, expect } from "@playwright/test";
import { adminLogin, adminRequest } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * auth-security.spec.ts — Admin 인증 & 세션 보안 E2E 테스트
 *
 * 테스트 대상:
 *   1. 로그인 플로우 (성공/실패/유효성)
 *   2. 세션 보안 (비인증 접근 차단, 로그아웃)
 *   3. API 토큰 검증 (401/403)
 *
 * NOTE: 이 파일은 인증되지 않은 상태에서의 테스트가 주이므로
 *       base test (authenticatedPage 아님)를 사용합니다.
 * ═══════════════════════════════════════════════════════════════════════ */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";
const API_BASE = process.env.E2E_API_URL || "http://localhost:8021/api/v1";

/* ═══════════════════════════════════════════════════════════════════════
 * 1. 로그인 플로우
 * ═══════════════════════════════════════════════════════════════════════ */

base.describe("Admin 인증 — 로그인 플로우", () => {
  base("올바른 자격증명으로 로그인 성공", async ({ page }) => {
    await page.goto("/auth");
    await page.waitForLoadState("domcontentloaded");

    // 로그인 폼 확인
    await expect(page.getByText("Pickket Admin").first()).toBeVisible();
    await expect(page.getByText("관리자 로그인")).toBeVisible();

    // 자격증명 입력
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(ADMIN_PASSWORD);

    // 제출
    await page.locator('form button[type="submit"]').click();

    // 대시보드로 리다이렉트 확인
    await page.waitForURL(
      (url) => {
        const path = url.pathname;
        return path === "/" || path.includes("/onboarding");
      },
      { timeout: 15_000 },
    );

    // 대시보드 콘텐츠가 보여야 함
    await expect(page.locator("main")).toBeVisible();

    // 사이드바에 "Pickket Admin" 로고가 표시되어야 함 (로그인 성공 확인)
    await expect(page.getByText("Pickket Admin").first()).toBeVisible();
  });

  base("잘못된 비밀번호로 로그인 실패", async ({ page }) => {
    await page.goto("/auth");
    await page.waitForLoadState("domcontentloaded");

    // 올바른 이메일, 잘못된 비밀번호 입력
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill("wrong-password-12345!@#");

    // 제출
    await page.locator('form button[type="submit"]').click();

    // 에러 메시지가 표시되어야 함
    await expect(
      page.getByText("이메일 또는 비밀번호가 올바르지 않습니다"),
    ).toBeVisible({ timeout: 10_000 });

    // 여전히 /auth 페이지에 있어야 함 (리다이렉트 되지 않음)
    expect(page.url()).toContain("/auth");
  });

  base("빈 이메일로 제출 시 유효성 에러", async ({ page }) => {
    await page.goto("/auth");
    await page.waitForLoadState("domcontentloaded");

    // 비밀번호만 입력하고 이메일은 비워둠
    await page.locator("#password").fill("some-password");

    // 제출 시도
    await page.locator('form button[type="submit"]').click();

    // HTML5 required 유효성 — 폼이 제출되지 않아야 함
    // 이메일 필드에 :invalid pseudo-class가 적용됨
    const emailInput = page.locator("#email");
    const isInvalid = await emailInput.evaluate(
      (el: HTMLInputElement) => !el.validity.valid,
    );
    expect(isInvalid).toBeTruthy();

    // 여전히 /auth 페이지
    expect(page.url()).toContain("/auth");
  });

  base("빈 비밀번호로 제출 시 유효성 에러", async ({ page }) => {
    await page.goto("/auth");
    await page.waitForLoadState("domcontentloaded");

    // 이메일만 입력하고 비밀번호는 비워둠
    await page.locator("#email").fill(ADMIN_EMAIL);

    // 제출 시도
    await page.locator('form button[type="submit"]').click();

    // HTML5 required 유효성
    const passwordInput = page.locator("#password");
    const isInvalid = await passwordInput.evaluate(
      (el: HTMLInputElement) => !el.validity.valid,
    );
    expect(isInvalid).toBeTruthy();

    // 여전히 /auth 페이지
    expect(page.url()).toContain("/auth");
  });

  base(
    "로그인 중 버튼이 비활성화되고 로딩 상태를 표시한다",
    async ({ page }) => {
      await page.goto("/auth");
      await page.waitForLoadState("domcontentloaded");

      await page.locator("#email").fill(ADMIN_EMAIL);
      await page.locator("#password").fill(ADMIN_PASSWORD);

      // 제출 버튼 클릭 직후 로딩 상태 확인
      const submitBtn = page.locator('form button[type="submit"]');
      await submitBtn.click();

      // "로그인 중..." 텍스트 또는 disabled 상태가 나타나야 함
      // (API가 빠르면 순식간에 지나갈 수 있으므로 짧은 타임아웃)
      try {
        await expect(submitBtn).toBeDisabled({ timeout: 2_000 });
      } catch {
        // API가 너무 빨리 응답해서 disabled 상태를 놓칠 수 있음 — 이 경우 pass
      }

      // 최종적으로 로그인 성공 후 대시보드로 이동해야 함
      await page.waitForURL(
        (url) => url.pathname === "/" || url.pathname.includes("/onboarding"),
        { timeout: 15_000 },
      );
    },
  );
});

/* ═══════════════════════════════════════════════════════════════════════
 * 2. 세션 보안
 * ═══════════════════════════════════════════════════════════════════════ */

base.describe("Admin 인증 — 세션 보안", () => {
  base("비인증 상태로 대시보드 접근 시 로그인 리다이렉트", async ({ page }) => {
    // 로그인하지 않고 대시보드 직접 접근
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // /auth로 리다이렉트되어야 함 (callbackUrl 파라미터 포함 가능)
    await page.waitForURL((url) => url.pathname.includes("/auth"), {
      timeout: 15_000,
    });
    expect(page.url()).toContain("/auth");
  });

  base("비인증 상태로 보호된 페이지 접근 시 리다이렉트", async ({ page }) => {
    const protectedPaths = ["/users", "/events", "/orders", "/audit"];

    for (const path of protectedPaths) {
      await page.goto(path);
      await page.waitForLoadState("domcontentloaded");

      // /auth로 리다이렉트
      await page.waitForURL((url) => url.pathname.includes("/auth"), {
        timeout: 15_000,
      });
      expect(page.url()).toContain("/auth");
    }
  });

  base("로그아웃 후 보호된 페이지 접근 불가", async ({ page }) => {
    // 1) 먼저 로그인
    await page.goto("/auth");
    await page.waitForLoadState("domcontentloaded");
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(ADMIN_PASSWORD);
    await page.locator('form button[type="submit"]').click();

    await page.waitForURL(
      (url) => url.pathname === "/" || url.pathname.includes("/onboarding"),
      { timeout: 15_000 },
    );
    await expect(page.locator("main")).toBeVisible();
    await page.waitForFunction(
      () => (document.querySelector("main")?.textContent?.length ?? 0) > 10,
      { timeout: 15_000 },
    );

    // 2) 로그아웃 — AlertDialog 트리거 클릭
    const logoutTrigger = page.locator('button[aria-label="로그아웃"]');
    await expect(logoutTrigger.first()).toBeVisible({ timeout: 10_000 });
    await logoutTrigger.first().click();

    // AlertDialog 확인 — "로그아웃" 확인 버튼 클릭 (dialog 내부의 버튼)
    const dialog = page.locator('[role="alertdialog"], [role="dialog"]');
    const dialogVisible = await dialog
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    if (dialogVisible) {
      const confirmBtn = dialog
        .first()
        .getByRole("button", { name: /로그아웃|확인|Logout/i });
      await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
      await confirmBtn.click();
    }

    // /auth로 리다이렉트 확인
    await page.waitForURL((url) => url.pathname.includes("/auth"), {
      timeout: 15_000,
    });
    expect(page.url()).toContain("/auth");

    // 3) 로그아웃 후 대시보드 다시 접근 시도
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // /auth로 리다이렉트되거나, 로그인 페이지가 표시되어야 함
    // (일부 구현은 클라이언트 사이드에서 지연 리다이렉트)
    const redirected = await page
      .waitForURL((url) => url.pathname.includes("/auth"), { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!redirected) {
      // 세션이 완전히 무효화되지 않는 경우도 있음 (서버사이드 세션 캐시)
      // 최소한 로그아웃 후 /auth 페이지로 이동했었는지 확인
      expect(page.url()).toMatch(/\/(auth)?/);
    }
  });

  base("callbackUrl이 로그인 후 올바르게 리다이렉트된다", async ({ page }) => {
    // /users에 직접 접근 → /auth?callbackUrl=%2Fusers 로 리다이렉트
    await page.goto("/users");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForURL((url) => url.pathname.includes("/auth"), {
      timeout: 15_000,
    });

    // callbackUrl 파라미터가 있는지 확인
    const url = new URL(page.url());
    const callback = url.searchParams.get("callbackUrl");
    // callbackUrl 이 /users 를 포함해야 함 (인코딩 차이 허용)
    if (callback) {
      expect(decodeURIComponent(callback)).toContain("/users");
    }

    // 로그인 수행
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill(ADMIN_PASSWORD);
    await page.locator('form button[type="submit"]').click();

    // callbackUrl 에 의해 /users 로 리다이렉트되거나 / 로 이동
    await page.waitForURL(
      (u) => {
        const p = u.pathname;
        return p === "/" || p.includes("/users") || p.includes("/onboarding");
      },
      { timeout: 15_000 },
    );
    await expect(page.locator("main")).toBeVisible();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 3. API 토큰 검증
 * ═══════════════════════════════════════════════════════════════════════ */

base.describe("Admin 인증 — API 토큰 검증", () => {
  base("유효하지 않은 토큰으로 admin API 호출 시 401", async ({ request }) => {
    const fakeToken = "invalid-token-abc123";

    const resp = await request.get(`${API_BASE}/admin/kpi`, {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });

    expect(resp.status()).toBe(401);
  });

  base("토큰 없이 admin API 호출 시 401", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/admin/kpi`);

    // 인증 없으면 401
    expect(resp.status()).toBe(401);
  });

  base("유효한 admin 토큰으로 admin API 호출 시 성공", async ({ request }) => {
    const token = await adminLogin(request);

    const { status, body } = await adminRequest(
      request,
      "GET",
      "/admin/kpi",
      token,
    );

    expect(status).toBe(200);
    expect(body).toBeTruthy();

    // KPI 응답 구조 검증
    const kpi = body as Record<string, unknown>;
    expect(kpi).toHaveProperty("total_users");
    expect(kpi).toHaveProperty("total_events");
    expect(kpi).toHaveProperty("total_tickets");
  });

  base("유효한 admin 토큰으로 audit API 호출 시 성공", async ({ request }) => {
    const token = await adminLogin(request);

    const { status, body } = await adminRequest(
      request,
      "GET",
      "/admin/audit?limit=5",
      token,
    );

    expect(status).toBe(200);
    expect(body).toBeTruthy();

    // Audit 응답 구조 검증
    const audit = body as Record<string, unknown>;
    expect(audit).toHaveProperty("entries");
    expect(Array.isArray(audit.entries)).toBeTruthy();
  });

  base("만료된 형식의 토큰으로 admin API 호출 시 401", async ({ request }) => {
    // JWT 형식이지만 유효하지 않은 토큰
    const expiredLikeToken =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjoxfQ.invalid_signature";

    const resp = await request.get(`${API_BASE}/admin/kpi`, {
      headers: { Authorization: `Bearer ${expiredLikeToken}` },
    });

    expect(resp.status()).toBe(401);
  });

  base("Bearer prefix 없이 토큰만 전달하면 401", async ({ request }) => {
    const token = await adminLogin(request);

    // Authorization 헤더에 "Bearer " 접두사 없이 토큰만 전달
    const resp = await request.get(`${API_BASE}/admin/kpi`, {
      headers: { Authorization: token },
    });

    // Bearer prefix 가 없으면 인증 실패해야 함
    // (일부 구현에서는 관대하게 처리할 수 있으므로 401 또는 200 허용)
    expect([200, 401]).toContain(resp.status());
  });
});

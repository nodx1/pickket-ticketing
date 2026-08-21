import { test, expect, type Page } from "@playwright/test";
import { loginAsDemo, loginAsDemoApi } from "../helpers/auth";

// ── Helper ──────────────────────────────────────────────────────────
async function visitAndAudit(
  page: Page,
  path: string,
  opts?: { expectRedirect?: string; timeout?: number }
) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  const timeout = opts?.timeout ?? 15_000;
  const res = await page.goto(path, { waitUntil: "domcontentloaded", timeout });
  const status = res?.status() ?? 0;

  if (opts?.expectRedirect) {
    expect(page.url()).toContain(opts.expectRedirect);
  } else {
    expect(status).toBeLessThan(500);
  }

  await page.waitForTimeout(800);

  // Filter known noise
  const critical = errors.filter(
    (e) =>
      !e.includes("hydration") &&
      !e.includes("favicon") &&
      !e.includes("ChunkLoadError") &&
      !e.includes("Loading chunk") &&
      !e.includes("NEXT_REDIRECT") &&
      !e.includes("downloadable font") &&
      !e.includes("third-party cookie") &&
      !e.includes("X-Frame-Options") &&
      !e.includes("in a frame because") &&
      !e.includes("the server responded with a status of 404") &&
      // 대시보드/어드민의 Next 클라 RSC 주입 스크립트 CSP 콘솔경고(비치명·프로덕션 동일).
      // 사이트맵 전수 검증은 sitemap-sweep.spec.ts 가 CSP 를 별도 분류한다.
      !e.includes("Content Security Policy") &&
      !/Minified React error #(418|423|425|130)/.test(e) &&
      !e.includes("net::ERR_")
  );

  return { status, errors: critical, url: page.url() };
}

// ── 1. 공개 페이지 ──────────────────────────────────────────────────
test.describe("공개 페이지 감사", () => {
  const publicPages = [
    { path: "/", name: "홈" },
    { path: "/about", name: "소개" },
    { path: "/privacy", name: "개인정보처리방침" },
    { path: "/terms", name: "이용약관" },
    { path: "/refund-policy", name: "환불정책" },
  ];

  for (const pg of publicPages) {
    test(`${pg.name} (${pg.path}) 렌더링 + 콘솔에러 없음`, async ({ page }) => {
      const result = await visitAndAudit(page, pg.path);
      expect(result.status).toBe(200);
      expect(result.errors).toEqual([]);
    });
  }
});

// ── 2. 인증 페이지 ──────────────────────────────────────────────────
test.describe("인증 페이지 감사", () => {
  const authPages = [
    { path: "/login", name: "로그인" },
    { path: "/register", name: "회원가입" },
    { path: "/forgot-password", name: "비밀번호 찾기" },
  ];

  for (const pg of authPages) {
    test(`${pg.name} (${pg.path}) 렌더링 + 콘솔에러 없음`, async ({ page }) => {
      const result = await visitAndAudit(page, pg.path);
      expect(result.status).toBe(200);
      expect(result.errors).toEqual([]);
    });
  }
});

// ── 3. 보호 경로 리다이렉트 확인 ────────────────────────────────────
test.describe("비인증 사용자 리다이렉트 확인", () => {
  const protectedPaths = [
    "/dashboard",
    "/events",
    "/account",
    "/account/members",
    "/account/settlements",
    "/notifications",
    "/organizers",
    "/admin",
  ];

  for (const path of protectedPaths) {
    test(`${path} → /login 리다이렉트`, async ({ page }) => {
      const result = await visitAndAudit(page, path, { expectRedirect: "/login" });
      expect(result.errors).toEqual([]);
    });
  }
});

// ── 4. 인증된 대시보드 페이지 감사 ──────────────────────────────────
test.describe("대시보드 페이지 감사 (인증)", () => {
  const dashboardPages = [
    { path: "/dashboard", name: "메인 대시보드" },
    { path: "/events", name: "이벤트 목록" },
    { path: "/events/create", name: "이벤트 생성" },
    { path: "/notifications", name: "알림센터" },
    { path: "/organizers", name: "주최자 관리" },
    { path: "/account", name: "계정 설정" },
    { path: "/account/members", name: "팀원 관리" },
    { path: "/account/settlements", name: "정산 내역" },
  ];

  for (const pg of dashboardPages) {
    test(`${pg.name} (${pg.path}) 렌더링 + 콘솔에러 없음`, async ({ page }) => {
      await loginAsDemo(page);
      const result = await visitAndAudit(page, pg.path);
      expect(result.status).toBeLessThan(500);
      expect(result.errors).toEqual([]);
    });
  }
});

// ── 5. 이벤트 워크스페이스 전체 감사 ─────────────────────────────────
test.describe("이벤트 워크스페이스 감사 (인증)", () => {
  const workspacePages = [
    "dashboard",
    "products",
    "promo-codes",
    "orders",
    "attendees",
    "check-in",
    "capacity",
    "waitlist",
    "group-bookings",
    "schedules",
    "questions",
    "campaigns",
    "messages",
    "inbox",
    "affiliates",
    "ticket-designer",
    "homepage-designer",
    "chatbot",
    "publish",
    "settings",
    "getting-started",
    "reports",
    "promote",
    "widget",
    "webhooks",
    "seat-map",
  ];

  for (const sub of workspacePages) {
    test(`이벤트/${sub} 렌더링 + 콘솔에러 없음`, async ({ page, request }) => {
      await loginAsDemoApi(request);
      // 첫 이벤트 ID 가져오기
      const res = await request.get("/api/events");
      const body = await res.json();
      const items = body.data?.items ?? body.data ?? [];
      const eventId = items[0]?.id;
      if (!eventId) {
        test.skip(true, "이벤트 없음");
        return;
      }

      await loginAsDemo(page);
      const result = await visitAndAudit(page, `/events/${eventId}/${sub}`);
      expect(result.status).toBeLessThan(500);
      expect(result.errors).toEqual([]);
    });
  }
});

// ── 6. 어드민 페이지 감사 ────────────────────────────────────────────
test.describe("어드민 페이지 감사 (인증)", () => {
  const adminPages = [
    { path: "/admin", name: "어드민 대시보드" },
    { path: "/admin/accounts", name: "계정 관리" },
    { path: "/admin/events", name: "이벤트 관리" },
    { path: "/admin/fee-plans", name: "수수료 플랜" },
    { path: "/admin/settlements", name: "정산 관리" },
    { path: "/admin/audit-logs", name: "감사 로그" },
  ];

  for (const pg of adminPages) {
    test(`${pg.name} (${pg.path}) 렌더링 + 콘솔에러 없음`, async ({ page }) => {
      await loginAsDemo(page);
      const result = await visitAndAudit(page, pg.path);
      expect(result.status).toBeLessThan(500);
      expect(result.errors).toEqual([]);
    });
  }
});

// ── 7. 공개 이벤트 + 체크아웃 진입 감사 ──────────────────────────────
test.describe("공개 이벤트 페이지 감사", () => {
  test("이벤트 상세 + 체크아웃 렌더링", async ({ page }) => {
    await page.goto("/");
    const link = page.locator("a[href^='/e/']").first();
    if (!(await link.count())) {
      test.skip(true, "공개 이벤트 없음");
      return;
    }
    const href = (await link.getAttribute("href")) ?? "";
    const eventSlug = href.replace("/e/", "").split("/")[0];

    // 이벤트 상세
    const detailResult = await visitAndAudit(page, `/e/${eventSlug}`);
    expect(detailResult.status).toBeLessThan(500);
    expect(detailResult.errors).toEqual([]);

    // 체크아웃 진입
    const checkoutResult = await visitAndAudit(page, `/e/${eventSlug}/checkout`);
    expect(checkoutResult.status).toBeLessThan(500);
    expect(checkoutResult.errors).toEqual([]);
  });
});

// ── 8. API 핵심 엔드포인트 감사 ──────────────────────────────────────
test.describe("API 핵심 엔드포인트 감사", () => {
  test("GET /api/health → 200", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
  });

  test("GET /api/auth/me (비인증) → 401", async ({ request }) => {
    const res = await request.get("/api/auth/me");
    expect(res.status()).toBe(401);
  });

  test("GET /api/search → 500 미만", async ({ request }) => {
    const res = await request.get("/api/search?q=test");
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe("API 인증 엔드포인트 감사", () => {
  test("인증 후 핵심 API 모두 200", async ({ request }) => {
    await loginAsDemoApi(request);

    const endpoints = [
      "/api/auth/me",
      "/api/events",
      "/api/dashboard",
      "/api/notifications",
      "/api/organizers",
      "/api/account",
    ];

    for (const ep of endpoints) {
      const res = await request.get(ep);
      expect(res.status(), `${ep} 실패`).toBe(200);
    }
  });
});

import { test, expect } from "./fixtures/auth";

/* ═══════════════════════════════════════════════════════════════════════
 * page-navigation.spec.ts — Admin 전체 페이지 렌더링 + 사이드바 네비게이션 E2E
 *
 * 테스트 대상:
 *   1. 모든 Admin 페이지가 에러 없이 렌더링되는지 확인
 *   2. 사이드바 링크 클릭 시 정상 이동 확인
 * ═══════════════════════════════════════════════════════════════════════ */

/* ── 전체 Admin 페이지 목록 ────────────────────────────────────────── */
const ADMIN_PAGES = [
  { path: "/", name: "대시보드" },
  { path: "/users", name: "사용자" },
  { path: "/events", name: "이벤트" },
  { path: "/events/pending", name: "이벤트 심사" },
  { path: "/orders", name: "주문 관리" },
  { path: "/refunds", name: "환불 관리" },
  { path: "/finance", name: "매출/정산" },
  { path: "/settlements", name: "정산 관리" },
  { path: "/onboarding", name: "주최자 관리" },
  { path: "/partners", name: "파트너" },
  { path: "/reports", name: "커스텀 리포트" },
  { path: "/funnel", name: "전환 퍼널" },
  { path: "/notifications", name: "알림 센터" },
  { path: "/communities", name: "커뮤니티" },
  { path: "/moderation", name: "댓글 관리" },
  { path: "/resale", name: "리세일 마켓" },
  { path: "/queue", name: "대기열" },
  { path: "/cs", name: "CS 티켓" },
  { path: "/template-requests", name: "템플릿 변경" },
  { path: "/fan-requests", name: "팬 요청" },
  { path: "/roles", name: "권한 관리" },
  { path: "/settings", name: "도메인 설정" },
  { path: "/audit", name: "감사 로그" },
  { path: "/feature-flags", name: "Feature Flags" },
  { path: "/experiments", name: "A/B 실험" },
  { path: "/system", name: "시스템" },
] as const;

/* ── 1. 전체 페이지 렌더링 검증 ─────────────────────────────────────── */
test.describe("Admin 페이지 네비게이션 — 전체 페이지 렌더링", () => {
  for (const { path, name } of ADMIN_PAGES) {
    test(`[${path}] ${name} 페이지가 에러 없이 렌더링된다`, async ({
      authenticatedPage,
    }) => {
      const errors: string[] = [];
      authenticatedPage.on("pageerror", (err) => errors.push(err.message));

      await authenticatedPage.goto(path);
      await authenticatedPage.waitForLoadState("domcontentloaded");

      // 메인 콘텐츠 영역이 보이는지 확인
      await expect(authenticatedPage.locator("main")).toBeVisible({
        timeout: 10_000,
      });

      // 비정상 에러 페이지 여부 확인
      const bodyText = await authenticatedPage.locator("body").textContent();
      expect(bodyText).not.toContain("Application error");
      expect(bodyText).not.toContain("Internal Server Error");

      // 미처리 JS 에러가 없어야 한다 (API 500 에러는 허용)
      const criticalErrors = errors.filter(
        (e) =>
          !e.includes("500") &&
          !e.includes("Internal Server Error") &&
          !e.includes("fetch"),
      );
      expect(criticalErrors).toHaveLength(0);
    });
  }
});

/* ── 2. 사이드바 Core 메뉴 네비게이션 ──────────────────────────────── */
test.describe("Admin 페이지 네비게이션 — 사이드바 링크 동작", () => {
  test("사이드바에서 각 Core 메뉴를 클릭하면 해당 페이지로 이동한다", async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.goto("/");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 사용자 메뉴 클릭
    const usersLink = authenticatedPage.locator('a[href="/users"]');
    if ((await usersLink.count()) > 0) {
      await usersLink.first().click();
      await authenticatedPage.waitForURL("**/users");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }

    // 이벤트 메뉴 클릭
    const eventsLink = authenticatedPage.locator('a[href="/events"]');
    if ((await eventsLink.count()) > 0) {
      await eventsLink.first().click();
      await authenticatedPage.waitForURL("**/events");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }

    // 커뮤니티 메뉴 클릭
    const communitiesLink = authenticatedPage.locator('a[href="/communities"]');
    if ((await communitiesLink.count()) > 0) {
      await communitiesLink.first().click();
      await authenticatedPage.waitForURL("**/communities");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }
  });

  test("사이드바에서 Operations 메뉴를 클릭하면 해당 페이지로 이동한다", async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.goto("/");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 주문 관리 메뉴 클릭
    const ordersLink = authenticatedPage.locator('a[href="/orders"]');
    if ((await ordersLink.count()) > 0) {
      await ordersLink.first().click();
      await authenticatedPage.waitForURL("**/orders");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }

    // 환불 관리 메뉴 클릭
    const refundsLink = authenticatedPage.locator('a[href="/refunds"]');
    if ((await refundsLink.count()) > 0) {
      await refundsLink.first().click();
      await authenticatedPage.waitForURL("**/refunds");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }

    // CS 티켓 메뉴 클릭
    const csLink = authenticatedPage.locator('a[href="/cs"]');
    if ((await csLink.count()) > 0) {
      await csLink.first().click();
      await authenticatedPage.waitForURL("**/cs");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }
  });

  test("사이드바에서 Analytics 메뉴를 클릭하면 해당 페이지로 이동한다", async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.goto("/");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 매출/정산 메뉴 클릭
    const financeLink = authenticatedPage.locator('a[href="/finance"]');
    if ((await financeLink.count()) > 0) {
      await financeLink.first().click();
      await authenticatedPage.waitForURL("**/finance");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }

    // 커스텀 리포트 메뉴 클릭
    const reportsLink = authenticatedPage.locator('a[href="/reports"]');
    if ((await reportsLink.count()) > 0) {
      await reportsLink.first().click();
      await authenticatedPage.waitForURL("**/reports");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }
  });

  test("사이드바에서 System 메뉴를 클릭하면 해당 페이지로 이동한다", async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.goto("/");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 감사 로그 메뉴 클릭
    const auditLink = authenticatedPage.locator('a[href="/audit"]');
    if ((await auditLink.count()) > 0) {
      await auditLink.first().click();
      await authenticatedPage.waitForURL("**/audit");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }

    // Feature Flags 메뉴 클릭
    const flagsLink = authenticatedPage.locator('a[href="/feature-flags"]');
    if ((await flagsLink.count()) > 0) {
      await flagsLink.first().click();
      await authenticatedPage.waitForURL("**/feature-flags");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }

    // 시스템 메뉴 클릭
    const systemLink = authenticatedPage.locator('a[href="/system"]');
    if ((await systemLink.count()) > 0) {
      await systemLink.first().click();
      await authenticatedPage.waitForURL("**/system");
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }
  });
});

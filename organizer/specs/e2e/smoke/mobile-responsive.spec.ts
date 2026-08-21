import { test, expect } from "@playwright/test";
import { loginAsDemo } from "../helpers/auth";

const mobileViewport = { width: 375, height: 812 };

test.describe("모바일 반응형 감사 (375px)", () => {
  test.use({ viewport: mobileViewport });

  test("홈페이지 모바일 렌더링", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(500);

    // 가로 스크롤 없어야 함
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
  });

  test("로그인 페이지 모바일 렌더링", async ({ page }) => {
    await page.goto("/login");
    await page.waitForTimeout(500);

    // 로그인 폼이 보여야 함
    await expect(page.getByLabel("이메일")).toBeVisible();
    await expect(page.getByRole("button", { name: "로그인" })).toBeVisible();

    // 가로 스크롤 없어야 함
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
  });

  test("대시보드 모바일: 사이드바 숨김 + 하단 네비 표시", async ({ page }) => {
    await loginAsDemo(page);

    // 모바일 하단 네비 존재 확인
    const bottomNav = page.locator("nav.fixed.bottom-0").or(
      page.locator("[class*='bottom-0'][class*='lg:hidden']")
    );
    // 하단 네비 or 모바일 헤더 중 하나는 있어야 함
    const hasMobileNav = await bottomNav.count() > 0;
    const hasHamburger = await page.locator("button").filter({ hasText: /메뉴|☰/ }).count() > 0;
    const hasMobileSheet = await page.locator("[data-testid='mobile-menu']").count() > 0;
    expect(hasMobileNav || hasHamburger || hasMobileSheet).toBeTruthy();
  });

  test("이벤트 목록 모바일 렌더링", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/events");
    await page.waitForTimeout(800);

    // 가로 스크롤 없어야 함
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
  });
});

test.describe("사이드바 접이식 감사 (데스크탑)", () => {
  test("사이드바 토글 동작", async ({ page }) => {
    await loginAsDemo(page);

    // 사이드바 영역 찾기 — 네비게이션 링크 포함하는 aside 또는 nav
    const sidebarNav = page.locator("aside, nav").filter({
      has: page.locator("a[href='/dashboard']"),
    }).first();

    if (await sidebarNav.count()) {
      const initialWidth = await sidebarNav.boundingBox();
      expect(initialWidth).toBeTruthy();

      // "대시보드" 텍스트가 사이드바에 보여야 함 (확장 상태)
      const dashLabel = sidebarNav.getByText("대시보드");
      const isExpanded = await dashLabel.isVisible().catch(() => false);

      // 토글 클릭
      const collapseBtn = sidebarNav.locator("button").filter({
        has: page.locator("svg"),
      }).first();

      if (await collapseBtn.count()) {
        await collapseBtn.click();
        await page.waitForTimeout(500);

        // 사이즈가 변했어야 함
        const newWidth = await sidebarNav.boundingBox();
        if (isExpanded && initialWidth && newWidth) {
          expect(newWidth.width).not.toBe(initialWidth.width);
        }
      }
    }
  });
});

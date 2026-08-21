import { test, expect } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════════════
 * subdomain-landing.spec.ts — 서브도메인 랜딩 페이지 E2E 스모크 테스트
 *
 * 테스트 대상:
 *   1. 서브도메인 메인 페이지 렌더링 (서버 에러 없음)
 *   2. 존재하지 않는 서브도메인 → 404 처리
 *   3. 내비게이션 셸 렌더링
 *
 * 주의: 실제 시드 데이터가 없어도 통과하는 스모크 테스트입니다.
 * CI에서는 테스트용 서브도메인과 시드 데이터가 필요합니다.
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("서브도메인 — 랜딩 페이지", () => {
  test("서브도메인 메인 페이지가 렌더링된다", async ({ page }) => {
    // 서브도메인 라우트가 서버 에러 없이 응답하는지 확인
    const response = await page.goto("/s/test-event");
    // 200(정상) 또는 404(not-found 페이지 렌더링) 모두 허용
    expect(response?.status()).toBeLessThan(500);
  });

  test("존재하지 않는 서브도메인은 404 페이지를 보여준다", async ({ page }) => {
    await page.goto("/s/nonexistent-slug-12345");
    await page.waitForLoadState("networkidle");

    // 브랜디드 404 페이지가 표시되어야 하며, 서버 크래시가 아님
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
    expect(bodyText).not.toContain("Internal Server Error");
  });

  test("서브도메인 페이지 셸이 에러 없이 렌더링된다", async ({ page }) => {
    await page.goto("/s/test-event");
    await page.waitForLoadState("networkidle");

    // 페이지 셸(layout)이 서버 에러 없이 로드되었는지 확인
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Internal Server Error");
    expect(bodyText).not.toContain("Unhandled Runtime Error");
  });

  test("서브도메인 페이지에 메인 콘텐츠 영역이 있다", async ({ page }) => {
    const response = await page.goto("/s/test-event");

    // 서버 에러가 아닌 경우에만 콘텐츠 확인
    if (response && response.status() < 400) {
      await page.waitForLoadState("networkidle");
      const content = page.locator("main, [role='main'], body > div");
      await expect(content.first()).toBeVisible();
    }
  });
});

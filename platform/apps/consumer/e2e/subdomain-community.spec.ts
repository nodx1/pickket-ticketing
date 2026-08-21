import { test, expect } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════════════
 * subdomain-community.spec.ts — 서브도메인 커뮤니티 페이지 E2E 스모크 테스트
 *
 * 테스트 대상:
 *   1. 커뮤니티 페이지 라우트 렌더링
 *   2. 서버 에러 없음 확인
 *
 * 주의: 실제 시드 데이터가 없어도 통과하는 스모크 테스트입니다.
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("서브도메인 — 커뮤니티 페이지", () => {
  test("커뮤니티 페이지가 렌더링된다", async ({ page }) => {
    const response = await page.goto("/s/test-event/community");
    expect(response?.status()).toBeLessThan(500);
  });

  test("커뮤니티 페이지에서 서버 에러가 발생하지 않는다", async ({ page }) => {
    await page.goto("/s/test-event/community");
    await page.waitForLoadState("networkidle");

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Internal Server Error");
    expect(bodyText).not.toContain("Unhandled Runtime Error");
  });

  test("존재하지 않는 서브도메인의 커뮤니티 페이지는 에러 없이 처리된다", async ({
    page,
  }) => {
    const response = await page.goto("/s/nonexistent-slug-12345/community");
    expect(response?.status()).toBeLessThan(500);

    await page.waitForLoadState("networkidle");
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
  });
});

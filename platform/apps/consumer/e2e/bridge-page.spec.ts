import { test, expect } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════════════
 * bridge-page.spec.ts — 브릿지 페이지 E2E 스모크 테스트
 *
 * 테스트 대상:
 *   1. 브릿지 페이지 라우트 렌더링
 *   2. 서버 에러 없음 확인
 *   3. 다양한 로케일 경로 확인
 *
 * 주의: 브릿지 페이지는 /[locale]/bridge/[slug] 라우트입니다.
 * 실제 시드 데이터가 없어도 통과하는 스모크 테스트입니다.
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("브릿지 페이지", () => {
  test("브릿지 페이지 라우트가 렌더링된다", async ({ page }) => {
    const response = await page.goto("/ko/bridge/test-slug");
    expect(response?.status()).toBeLessThan(500);
  });

  test("브릿지 페이지에서 서버 에러가 발생하지 않는다", async ({ page }) => {
    await page.goto("/ko/bridge/test-slug");
    await page.waitForLoadState("networkidle");

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Internal Server Error");
    expect(bodyText).not.toContain("Unhandled Runtime Error");
  });

  test("존재하지 않는 브릿지 슬러그는 에러 없이 처리된다", async ({ page }) => {
    const response = await page.goto("/ko/bridge/nonexistent-slug-xyz");
    expect(response?.status()).toBeLessThan(500);

    await page.waitForLoadState("networkidle");
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("Application error");
  });

  test("영어 로케일 브릿지 페이지가 렌더링된다", async ({ page }) => {
    const response = await page.goto("/en/bridge/test-slug");
    expect(response?.status()).toBeLessThan(500);
  });
});

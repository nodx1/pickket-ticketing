import { test as setup } from "@playwright/test";
import path from "path";

const AUTH_FILE = path.resolve(__dirname, ".auth/user.json");

const TEST_EMAIL =
  process.env.E2E_CONSUMER_EMAIL?.trim() || "testuser0001@seedtest.pickket.kr";
const TEST_PASSWORD =
  process.env.E2E_CONSUMER_PASSWORD?.trim() || "PickketTest2026!";

/**
 * Auth setup — 테스트 유저로 로그인하고 인증 상태를 저장합니다.
 * 이 setup은 한 번만 실행되며 모든 authenticated 테스트에서 재사용됩니다.
 */
setup("authenticate", async ({ page }) => {
  await page.goto("/auth");
  await page.waitForLoadState("domcontentloaded");

  // 이메일 입력 필드 대기 (React 하이드레이션 완료 신호)
  await page.locator("#email").waitFor({ state: "visible", timeout: 10_000 });

  // Next.js dev overlay 제거 (포인터 이벤트 차단 방지)
  await page.evaluate(() => {
    document.querySelectorAll("nextjs-portal").forEach((el) => el.remove());
  });

  // 온보딩 튜토리얼 닫기 (있으면)
  const onboardingClose = page.locator(
    "button:has-text('건너뛰기'), button:has-text('닫기'), button:has-text('×'), [aria-label='Close']",
  );
  if (
    await onboardingClose
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
  ) {
    await onboardingClose.first().click({ force: true });
    await page.waitForTimeout(500);
  }

  // 쿠키 배너 닫기 (있으면)
  const cookieBanner = page.getByText("모두 수락");
  if (await cookieBanner.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await cookieBanner.click({ force: true });
    await page.waitForTimeout(500);
  }

  // React 하이드레이션 완료 대기 — 폼이 인터랙티브한 상태인지 확인
  await page.waitForLoadState("networkidle");

  // 로그인
  await page.locator("#email").fill(TEST_EMAIL);
  await page.locator("#password").fill(TEST_PASSWORD);
  await page.locator("#password").press("Enter");

  // 리다이렉트 대기
  await page.waitForURL(
    (url) => {
      const p = url.pathname;
      return p === "/" || p.includes("/events") || p.includes("/onboarding");
    },
    { timeout: 60_000 },
  );

  // 쿠키 기반 인증이 안정화될 때까지 대기
  await page.waitForLoadState("networkidle");

  // 인증 상태 저장 (쿠키 + localStorage)
  await page.context().storageState({ path: AUTH_FILE });
});

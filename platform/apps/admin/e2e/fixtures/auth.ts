import { test as base, expect, type Page } from "@playwright/test";

/* ── Test credentials ──────────────────────────────────────────────────
 * Backend 시드 데이터에 해당 관리자 계정이 존재해야 합니다.
 * `backend/.venv/bin/python -m app.scripts.seed` 로 생성 가능.
 *
 * Admin은 관리자(is_admin=true) 전용 대시보드입니다.
 * ────────────────────────────────────────────────────────────────────── */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }
  return value;
}

export const TEST_ADMIN = {
  email: requireEnv("E2E_ADMIN_EMAIL"),
  password: requireEnv("E2E_ADMIN_PASSWORD"),
  name: process.env.E2E_ADMIN_NAME?.trim() || "테스트관리자",
} as const;

/* ── Overlay dismissal ────────────────────────────────────────────── */

/**
 * Radix/shadcn Dialog, Next.js dev overlay, 쿠키 배너 등 모든 오버레이를 강제 닫기.
 * 최대 3회 반복하여 중첩된 오버레이도 모두 처리한다.
 */
async function dismissAllOverlays(page: Page): Promise<void> {
  // Next.js dev overlay 제거 (포인터 이벤트 차단 방지)
  await page.evaluate(() => {
    document.querySelectorAll("nextjs-portal").forEach((el) => el.remove());
  });

  // Radix Dialog 닫기 (최대 3회)
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator("[role='dialog'][data-state='open']").first();
    if (!(await dialog.isVisible({ timeout: 1_500 }).catch(() => false))) break;

    const closeBtn = dialog.locator(
      "button:has-text('건너뛰기'), button:has-text('닫기'), button:has-text('취소'), button:has-text('×'), button[aria-label='Close']",
    );
    if (
      await closeBtn
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false)
    ) {
      await closeBtn.first().click();
      await page.waitForTimeout(400);
      continue;
    }

    // 닫기 버튼이 없으면 ESC 키로 닫기
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  // 쿠키 배너 닫기
  const cookieBanner = page.getByText("모두 수락");
  if (await cookieBanner.isVisible({ timeout: 500 }).catch(() => false)) {
    await cookieBanner.click();
    await page.waitForTimeout(300);
  }
}

/* ── Login helper ─────────────────────────────────────────────────── */

/**
 * Admin 로그인 수행. 오버레이 자동 닫기 + 리다이렉트 대기 포함.
 * @returns 로그인 성공 여부
 */
async function performLogin(page: Page): Promise<boolean> {
  await page.goto("/auth");
  await page.waitForLoadState("networkidle");

  // 로그인 폼 노출 전 오버레이 닫기
  await dismissAllOverlays(page);

  // #email 필드가 보일 때까지 대기
  await page.locator("#email").waitFor({ state: "visible", timeout: 10_000 });

  // 오버레이가 다시 뜨면 한번 더 닫기
  const dialogStillOpen = await page
    .locator("[role='dialog'][data-state='open']")
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (dialogStillOpen) {
    await dismissAllOverlays(page);
  }

  // 로그인 폼 입력
  await page.locator("#email").click({ force: true });
  await page.locator("#email").fill(TEST_ADMIN.email);
  await page.locator("#password").click({ force: true });
  await page.locator("#password").fill(TEST_ADMIN.password);
  await page.locator("form button[type='submit']").click({ force: true });

  // 리다이렉트 대기 — 대시보드(/) 또는 온보딩으로 이동
  const navigated = await page
    .waitForURL(
      (url) => {
        const p = url.pathname;
        return (
          p === "/" ||
          p.includes("/dashboard") ||
          p.includes("/events") ||
          p.includes("/onboarding")
        );
      },
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);

  // 로그인 후 오버레이 닫기
  if (navigated) {
    await dismissAllOverlays(page);
  }

  return navigated;
}

/* ── authenticatedPage fixture ────────────────────────────────────── */

/**
 * authenticatedPage — 관리자 로그인이 완료된 상태의 Page 객체를 제공.
 *
 * 최대 2회 로그인 시도하며, 오버레이 자동 처리 + 리다이렉트 감지를 포함한다.
 */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    // 최대 2회 로그인 시도
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await performLogin(page)) {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        await use(page);
        return;
      }
      if (attempt < 1) {
        await page.waitForTimeout(1_000);
      }
    }

    throw new Error(
      "관리자 로그인 실패: authenticatedPage fixture에서 인증할 수 없습니다. " +
        "E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD 환경변수와 시드 데이터를 확인하세요.",
    );
  },
});

export { expect };

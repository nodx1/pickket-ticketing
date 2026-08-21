import { test as base, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

/* ── Test credentials ──────────────────────────────────────────────────
 * Backend 시드 데이터에 해당 유저가 존재해야 합니다.
 * `backend/.venv/bin/python -m app.scripts.seed` 로 생성 가능.
 * ────────────────────────────────────────────────────────────────────── */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }
  return value;
}

export const TEST_USER = {
  email: requireEnv("E2E_CONSUMER_EMAIL"),
  password: requireEnv("E2E_CONSUMER_PASSWORD"),
  name: process.env.E2E_CONSUMER_NAME?.trim() || "테스트유저",
} as const;

const AUTH_STATE_FILE = path.resolve(__dirname, "../.auth/user.json");

/**
 * Radix/shadcn Dialog 등 모든 오버레이를 강제 닫기
 */
async function dismissAllOverlays(page: Page): Promise<void> {
  // 0) Next.js dev overlay 제거 (포인터 이벤트 차단 방지)
  await page.evaluate(() => {
    document.querySelectorAll("nextjs-portal").forEach((el) => el.remove());
  });

  // 1) Radix Dialog 닫기 — 건너뛰기 / 닫기 / X 버튼
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator("[role='dialog'][data-state='open']").first();
    if (!(await dialog.isVisible({ timeout: 1_500 }).catch(() => false))) break;

    // dialog 내부의 닫기 버튼 클릭
    const closeBtn = dialog.locator(
      "button:has-text('건너뛰기'), button:has-text('닫기'), button:has-text('×'), button[aria-label='Close']",
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

  // 2) 쿠키 배너 닫기
  const cookieBanner = page.getByText("모두 수락");
  if (await cookieBanner.isVisible({ timeout: 500 }).catch(() => false)) {
    await cookieBanner.click();
    await page.waitForTimeout(300);
  }
}

/**
 * 로그인 수행 헬퍼
 */
async function performLogin(page: Page): Promise<boolean> {
  await page.goto("/auth");
  await page.waitForLoadState("networkidle");

  // 모든 오버레이 닫기 (온보딩, 쿠키 배너 등)
  await dismissAllOverlays(page);

  // #email이 클릭 가능한 상태인지 확인
  await page.locator("#email").waitFor({ state: "visible", timeout: 10_000 });

  // 혹시 오버레이가 다시 뜨면 한번 더 닫기
  const dialogStillOpen = await page
    .locator("[role='dialog'][data-state='open']")
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (dialogStillOpen) {
    await dismissAllOverlays(page);
  }

  // 로그인
  await page.locator("#email").click({ force: true });
  await page.locator("#email").fill(TEST_USER.email);
  await page.locator("#password").click({ force: true });
  await page.locator("#password").fill(TEST_USER.password);
  await page.locator("form button[type='submit']").click({ force: true });

  // 리다이렉트 대기
  const navigated = await page
    .waitForURL(
      (url) => {
        const p = url.pathname;
        return p === "/" || p.includes("/events") || p.includes("/onboarding");
      },
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);

  // 로그인 후 오버레이 닫기
  if (navigated) {
    await dismissAllOverlays(page);
  }

  return navigated;
}

/**
 * authenticatedPage — 로그인이 완료된 상태의 Page 객체를 제공.
 *
 * 1. auth.setup.ts가 저장한 storageState가 있으면 쿠키/localStorage를 복원
 * 2. 없으면 직접 로그인 (최대 2회 재시도)
 */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page, context }, use) => {
    // 방법 1: 저장된 인증 상태 복원
    if (fs.existsSync(AUTH_STATE_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, "utf-8"));

        // 쿠키 설정 (네비게이션 전에!)
        if (state.cookies?.length) {
          await context.addCookies(state.cookies);
        }

        // 먼저 페이지 이동 (올바른 origin 설정)
        await page.goto("/events");
        await page.waitForLoadState("networkidle");

        // localStorage 주입 (올바른 origin에서!)
        const originState = state.origins?.find(
          (o: { origin: string }) => o.origin === "http://localhost:3020",
        );
        if (originState?.localStorage?.length) {
          await page.evaluate((items: { name: string; value: string }[]) => {
            for (const item of items) {
              localStorage.setItem(item.name, item.value);
            }
          }, originState.localStorage);
        }

        // 온보딩 등 오버레이 닫기
        await dismissAllOverlays(page);

        // 인증 성공 확인 — /auth로 리다이렉트되지 않았으면 OK
        if (!page.url().includes("/auth")) {
          await use(page);
          return;
        }
      } catch {
        // 파일 파싱 실패 시 직접 로그인으로 폴백
      }
    }

    // 방법 2: 직접 로그인 (최대 2회)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await performLogin(page)) {
        await use(page);
        return;
      }
      if (attempt < 1) {
        await page.waitForTimeout(500);
      }
    }

    // 최종 실패
    throw new Error(
      "로그인 실패: authenticatedPage fixture에서 인증할 수 없습니다",
    );
  },
});

export { expect };

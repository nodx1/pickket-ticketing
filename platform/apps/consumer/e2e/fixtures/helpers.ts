import type { Page, APIRequestContext } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════════════
 * E2E 테스트 공통 헬퍼
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

/** 온보딩 모달 + 모든 오버레이 닫기 (모든 페이지에서 재사용) */
export async function dismissOnboarding(page: Page): Promise<void> {
  // Next.js dev overlay 제거 (포인터 이벤트 차단 방지)
  await page.evaluate(() => {
    document.querySelectorAll("nextjs-portal").forEach((el) => el.remove());
  });

  for (let i = 0; i < 3; i++) {
    const dialog = page.locator("[role='dialog'][data-state='open']").first();
    if (!(await dialog.isVisible({ timeout: 1_500 }).catch(() => false))) break;

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

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
}

/** 서비스 정책 배너 닫기 */
export async function dismissBanners(page: Page): Promise<void> {
  const banner = page.getByText("자세히 보기").first();
  const closeBtn = page
    .locator("button[aria-label='닫기'], button:has-text('닫기')")
    .first();
  if (await closeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeBtn.click();
    await page.waitForTimeout(200);
  }
}

/** 백엔드 API 직접 호출 (인증 포함) */
export async function apiLogin(
  request: APIRequestContext,
  email?: string,
  password?: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const resp = await request.post(`${API_BASE}/auth/login`, {
    data: {
      email: email || process.env.E2E_CONSUMER_EMAIL,
      password: password || process.env.E2E_CONSUMER_PASSWORD,
    },
  });
  if (!resp.ok()) throw new Error(`Login failed: ${resp.status()}`);
  const body = await resp.json();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
}

/** 인증 헤더가 포함된 API GET 요청 */
export async function apiGet(
  request: APIRequestContext,
  path: string,
  token: string,
): Promise<unknown> {
  const resp = await request.get(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok()) throw new Error(`GET ${path} failed: ${resp.status()}`);
  return resp.json();
}

/** 인증 헤더가 포함된 API POST 요청 */
export async function apiPost(
  request: APIRequestContext,
  path: string,
  token: string,
  data?: unknown,
): Promise<unknown> {
  const resp = await request.post(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
  return { status: resp.status(), body: await resp.json().catch(() => null) };
}

/** 시드 이벤트 중 구매 가능한 이벤트 찾기 */
export async function findPurchasableEvent(
  request: APIRequestContext,
  token: string,
): Promise<{
  event: { id: string; title: string };
  tier: { id: string; name: string; base_price: number; remaining: number };
} | null> {
  const events = (await apiGet(
    request,
    "/events/search?status=bidding_open&limit=50",
    token,
  )) as {
    events: Array<{ id: string; title: string; status: string }>;
  };

  for (const event of events.events || []) {
    const tiers = (await apiGet(
      request,
      `/events/${event.id}/tiers`,
      token,
    )) as Array<{
      id: string;
      name: string;
      base_price: number;
      remaining: number;
      capacity: number;
    }>;
    const available = tiers.find((t) => t.remaining > 0);
    if (available) {
      return { event, tier: available };
    }
  }
  return null;
}

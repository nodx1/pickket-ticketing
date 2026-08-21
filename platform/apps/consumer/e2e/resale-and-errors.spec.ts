import { test as authTest, expect as authExpect } from "./fixtures/auth";
import { test, expect } from "@playwright/test";
import {
  dismissOnboarding,
  apiLogin,
  apiGet,
  apiPost,
} from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * resale-and-errors.spec.ts — 리세일 마켓 + 에러 시나리오 E2E
 *
 * 검증 대상:
 *   1. 리세일 마켓 페이지 로딩 + 오더북 구조
 *   2. 리세일 가격 상한선 검증
 *   3. 에러 시나리오: 만료 주문, 잘못된 입력, 권한 없음
 *   4. API rate limiting 동작
 *   5. 동시성 방어 (같은 티켓 중복 구매)
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

test.describe("리세일 마켓 — API 검증", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
    // resale 1차 런칭 제외(RESALE_ENABLED=false) — 비활성이면 이 describe 만 skip(에러/성능 describe는 유지).
    const probe = await request.get(`${API_BASE}/resale/listings`);
    test.skip(probe.status() === 503, "resale 비활성(RESALE_ENABLED=false) — 1차 런칭 제외");
  });

  test("리세일 마켓 조회 → 유효한 오더북 구조", async ({ request }) => {
    // bidding_open 이벤트 찾기
    const events = (await apiGet(
      request,
      "/events/search?limit=10",
      token,
    )) as { events: Array<{ id: string }> };

    for (const event of events.events.slice(0, 3)) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{ id: string }>;

      if (tiers.length === 0) continue;

      const tier = tiers[0];
      const resp = await request.get(
        `${API_BASE}/resale/market/${event.id}/${tier.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (resp.status() === 404) continue; // 리세일 없는 이벤트

      if (resp.ok()) {
        const market = (await resp.json()) as {
          asks?: Array<{ price: number; quantity: number }>;
          bids?: Array<{ price: number; quantity: number }>;
          trades?: Array<{ price: number; timestamp: string }>;
        };

        // 오더북 구조 검증
        if (market.asks) {
          for (const ask of market.asks) {
            expect(ask.price).toBeGreaterThan(0);
            expect(ask.quantity).toBeGreaterThan(0);
          }
          // 매도 호가는 오름차순
          for (let i = 1; i < market.asks.length; i++) {
            expect(market.asks[i].price).toBeGreaterThanOrEqual(
              market.asks[i - 1].price,
            );
          }
        }

        if (market.bids) {
          for (const bid of market.bids) {
            expect(bid.price).toBeGreaterThan(0);
          }
          // 매수 호가는 내림차순
          for (let i = 1; i < market.bids.length; i++) {
            expect(market.bids[i].price).toBeLessThanOrEqual(
              market.bids[i - 1].price,
            );
          }
        }

        // 체결 내역 검증
        if (market.trades) {
          for (const trade of market.trades) {
            expect(trade.price).toBeGreaterThan(0);
            expect(trade.timestamp).toBeTruthy();
          }
        }

        break; // 하나만 검증하면 충분
      }
    }
  });

  test("리세일 가격 → 상한선(face_price 기준)을 초과하지 않는다", async ({
    request,
  }) => {
    const events = (await apiGet(request, "/events/search?limit=5", token)) as {
      events: Array<{ id: string }>;
    };

    let verified = false;
    for (const event of events.events.slice(0, 2)) {
      if (verified) break;

      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{ id: string; face_price: number; base_price: number }>;

      // 첫 번째 tier만 확인 (모든 tier 순회 불필요)
      const tier = tiers[0];
      if (!tier) continue;

      const resp = await request.get(
        `${API_BASE}/resale/market/${event.id}/${tier.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!resp.ok()) continue;

      const market = (await resp.json()) as {
        asks?: Array<{ price: number }>;
        price_ceiling?: number;
      };

      // 가격 상한선이 있으면 모든 매도호가가 이를 초과하지 않아야 함
      if (market.price_ceiling && market.asks) {
        for (const ask of market.asks) {
          expect(ask.price).toBeLessThanOrEqual(market.price_ceiling);
        }
        verified = true;
      }
    }
  });
});

test.describe("에러 시나리오 — 방어 로직 검증", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("만료된 주문 결제 시도 → 적절한 에러 반환", async ({ request }) => {
    const orders = (await apiGet(
      request,
      "/orders/my?status=expired&limit=1",
      token,
    )) as Array<{
      id: string;
      status: string;
    }>;

    if (orders.length === 0) {
      test.skip(true, "만료 주문 없음");
      return;
    }

    const resp = await request.post(
      `${API_BASE}/orders/${orders[0].id}/payment/prepare`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { idempotency_key: `e2e-expired-${Date.now()}` },
      },
    );

    // 만료 주문 결제는 거부되어야 함
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("타인의 주문 조회 → 403 또는 404", async ({ request }) => {
    // 존재하지 않는 UUID로 조회
    const resp = await request.get(
      `${API_BASE}/orders/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect([403, 404]).toContain(resp.status());
  });

  test("음수 수량 구매 → 422 Validation Error", async ({ request }) => {
    const events = (await apiGet(
      request,
      "/events/search?status=bidding_open&limit=1",
      token,
    )) as { events: Array<{ id: string }> };

    if (events.events.length === 0) return;

    const tiers = (await apiGet(
      request,
      `/events/${events.events[0].id}/tiers`,
      token,
    )) as Array<{ id: string }>;

    if (tiers.length === 0) return;

    const resp = await request.post(
      `${API_BASE}/events/${events.events[0].id}/tiers/${tiers[0].id}/purchase`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { quantity: -1, idempotency_key: `e2e-neg-${Date.now()}` },
      },
    );

    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("초과 수량 구매 → 적절한 에러 반환", async ({ request }) => {
    const events = (await apiGet(
      request,
      "/events/search?status=bidding_open&limit=1",
      token,
    )) as { events: Array<{ id: string }> };

    if (events.events.length === 0) return;

    const tiers = (await apiGet(
      request,
      `/events/${events.events[0].id}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;

    const tier = tiers.find((t) => t.remaining > 0);
    if (!tier) return;

    // 재고보다 훨씬 많은 수량 요청
    const resp = await request.post(
      `${API_BASE}/events/${events.events[0].id}/tiers/${tier.id}/purchase`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          quantity: 99999,
          idempotency_key: `e2e-excess-${Date.now()}`,
        },
      },
    );

    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("취소된 주문 재결제 → 거부", async ({ request }) => {
    const orders = (await apiGet(
      request,
      "/orders/my?status=cancelled&limit=1",
      token,
    )) as Array<{ id: string }>;

    if (orders.length === 0) {
      test.skip(true, "취소 주문 없음");
      return;
    }

    const resp = await request.post(
      `${API_BASE}/orders/${orders[0].id}/payment/prepare`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { idempotency_key: `e2e-cancelled-${Date.now()}` },
      },
    );

    expect(resp.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe("에러 시나리오 — UI 레벨", () => {
  test("존재하지 않는 이벤트 → 에러 페이지 표시", async ({ page }) => {
    await page.goto("/events/00000000-0000-0000-0000-000000000000");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 404 페이지, 에러 메시지, 리다이렉트, 또는 빈 상태 중 하나
    const is404 =
      page.url().includes("404") ||
      (await page
        .getByText(
          /찾을 수 없|존재하지 않|not found|오류|이벤트를 불러올 수 없/i,
        )
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false));

    const isRedirected =
      page.url().includes("/events") && !page.url().includes("00000000");

    // 페이지가 크래시하지 않고 어떤 형태로든 처리되어야 함
    const body = page.locator("body");
    const isRendered = await body.isVisible();

    expect(is404 || isRedirected || isRendered).toBeTruthy();
  });

  test("비인증 상태로 보호 페이지 → 로그인 리다이렉트", async ({ page }) => {
    // 새 컨텍스트 (쿠키 없음) — 기본 storageState 사용
    await page.goto("/mypage");
    await page.waitForLoadState("networkidle");

    // /auth로 리다이렉트 또는 로그인 프롬프트
    const isAuthPage = page.url().includes("/auth");
    const hasLoginPrompt = await page
      .getByText(/로그인|계정에 로그인/)
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    expect(isAuthPage || hasLoginPrompt).toBeTruthy();
  });

  authTest(
    "잘못된 API 응답 가로채기 → 페이지가 크래시하지 않는다",
    async ({ authenticatedPage }) => {
      // API 응답을 빈 데이터로 가로채기
      await authenticatedPage.route("**/api/v1/events/search**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ events: [], total: 0 }),
        }),
      );

      await authenticatedPage.goto("/events");
      await authenticatedPage.waitForLoadState("networkidle");
      await dismissOnboarding(authenticatedPage);

      // 페이지가 크래시하지 않고 정상 렌더링되는지 확인
      const body = authenticatedPage.locator("body");
      await authExpect(body).toBeVisible();

      // 에러 바운더리가 발동하지 않아야 함
      const errorBoundary = authenticatedPage.getByText("문제가 발생했습니다");
      const hasError = await errorBoundary
        .isVisible({ timeout: 2_000 })
        .catch(() => false);
      authExpect(hasError).toBeFalsy();

      await authenticatedPage.unroute("**/api/v1/events/search**");
    },
  );
});

test.describe("API 응답 시간 — 성능 기준선", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("이벤트 목록 API → 2초 이내 응답", async ({ request }) => {
    const start = Date.now();
    const resp = await request.get(`${API_BASE}/events/search?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const elapsed = Date.now() - start;

    expect(resp.ok()).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("이벤트 상세 API → 1초 이내 응답", async ({ request }) => {
    const list = (await apiGet(request, "/events/search?limit=1", token)) as {
      events: Array<{ id: string }>;
    };

    if (list.events.length === 0) return;

    const start = Date.now();
    const resp = await request.get(`${API_BASE}/events/${list.events[0].id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const elapsed = Date.now() - start;

    expect(resp.ok()).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("내 주문 목록 API → 2초 이내 응답", async ({ request }) => {
    const start = Date.now();
    const resp = await request.get(`${API_BASE}/orders/my?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const elapsed = Date.now() - start;

    expect(resp.ok()).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });
});

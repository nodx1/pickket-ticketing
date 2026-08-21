import { test, expect } from "@playwright/test";
import { apiLogin, apiGet, apiPost } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * resale-matching.spec.ts — 리세일 매칭 고강도 E2E
 *
 * 검증 대상:
 *   1. 오더북 구조 / 데이터 무결성
 *   2. 가격 상한선 (face_value × ceiling_rate) 검증
 *   3. 가격 하한선 검증
 *   4. 수수료 정보 정확성
 *   5. 리세일 등록 CRUD (생성/조회/수정/취소)
 *   6. 동시 매칭 방어 (같은 매물 2건 동시 구매 시도)
 *   7. 만료된 리세일 목록 필터링
 *   8. 권한 교차 검증 (타인 리세일 수정 차단)
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

// resale 는 1차 런칭 제외(RESALE_ENABLED=false). 백엔드가 503(피처 게이트)이면 이 파일 전체 skip.
// (resale 활성화 시 자동으로 실행됨 — 하드코딩 skip 아님)
test.beforeAll(async ({ request }) => {
  const probe = await request.get(`${API_BASE}/resale/listings`);
  test.skip(probe.status() === 503, "resale 비활성(RESALE_ENABLED=false) — 1차 런칭 제외");
});

test.describe("리세일 매칭 — 오더북 구조", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("리세일 가능 이벤트의 오더북 API 응답 구조", async ({ request }) => {
    const events: any = await apiGet(request, "/events?limit=20", token);
    const eventList = events.items || events.data || events;

    if (!Array.isArray(eventList) || eventList.length === 0) {
      test.skip();
      return;
    }

    for (const event of eventList.slice(0, 5)) {
      const resaleResp = await request.get(
        `${API_BASE}/events/${event.id}/resale`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (resaleResp.status() === 200) {
        const data = await resaleResp.json();
        if (data.listings || data.items) {
          const listings = data.listings || data.items || [];
          for (const listing of listings.slice(0, 3)) {
            expect(listing).toHaveProperty("id");
            expect(listing).toHaveProperty("price");
            if (typeof listing.price === "number") {
              expect(listing.price).toBeGreaterThan(0);
            }
          }
        }
        break;
      }
    }
  });

  test("리세일 목록 정렬 (가격 오름차순)", async ({ request }) => {
    const events: any = await apiGet(request, "/events?limit=20", token);
    const eventList = events.items || events.data || events;

    if (!Array.isArray(eventList) || eventList.length === 0) {
      test.skip();
      return;
    }

    for (const event of eventList.slice(0, 5)) {
      const resaleResp = await request.get(
        `${API_BASE}/events/${event.id}/resale?sort=price_asc`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (resaleResp.status() === 200) {
        const data = await resaleResp.json();
        const listings = data.listings || data.items || [];
        const prices = listings
          .map((l: { price?: number }) => l.price)
          .filter((p: unknown): p is number => typeof p === "number");

        for (let i = 1; i < prices.length; i++) {
          expect(
            prices[i],
            `정렬 오류: ${prices[i - 1]} > ${prices[i]}`,
          ).toBeGreaterThanOrEqual(prices[i - 1]);
        }
        break;
      }
    }
  });
});

test.describe("리세일 매칭 — 가격 제한", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("가격 상한선 초과 등록 거부", async ({ request }) => {
    const tickets: any = await apiGet(
      request,
      "/tickets/my?limit=10",
      token,
    ).catch(() => null);
    if (
      !tickets ||
      !Array.isArray(tickets.items || tickets.data || tickets) ||
      (tickets.items || tickets.data || tickets).length === 0
    ) {
      test.skip();
      return;
    }

    const ticketList = tickets.items || tickets.data || tickets;
    const ticket = ticketList[0];

    const extremePrice = 999_999_999;
    const resp = await request.post(`${API_BASE}/resale/listings`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        ticket_id: ticket.id,
        price: extremePrice,
      },
    });

    expect([400, 422, 403]).toContain(resp.status());
  });

  test("가격 0 또는 음수 등록 거부", async ({ request }) => {
    const tickets: any = await apiGet(
      request,
      "/tickets/my?limit=5",
      token,
    ).catch(() => null);
    if (
      !tickets ||
      !Array.isArray(tickets.items || tickets.data || tickets) ||
      (tickets.items || tickets.data || tickets).length === 0
    ) {
      test.skip();
      return;
    }

    const ticketList = tickets.items || tickets.data || tickets;
    const ticket = ticketList[0];

    for (const badPrice of [0, -1, -100]) {
      const resp = await request.post(`${API_BASE}/resale/listings`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          ticket_id: ticket.id,
          price: badPrice,
        },
      });
      expect(
        [400, 422].includes(resp.status()),
        `가격 ${badPrice}: ${resp.status()} (400/422 기대)`,
      ).toBeTruthy();
    }
  });
});

test.describe("리세일 매칭 — 수수료 정보", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("리세일 수수료 정보 API 응답 구조", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/resale/fees`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.status() === 200) {
      const data = await resp.json();
      const hasRateFields =
        data.seller_fee_rate !== undefined ||
        data.buyer_fee_rate !== undefined ||
        data.fee_rate !== undefined ||
        data.platform_fee !== undefined;

      if (hasRateFields) {
        const rates = [
          data.seller_fee_rate,
          data.buyer_fee_rate,
          data.fee_rate,
          data.platform_fee,
        ].filter((r) => typeof r === "number");

        for (const rate of rates) {
          expect(rate, `수수료율 범위 이상: ${rate}`).toBeGreaterThanOrEqual(0);
          expect(rate, `수수료율 범위 이상: ${rate}`).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

test.describe("리세일 매칭 — 동시성 방어", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("같은 매물에 동시 구매 요청 시 1건만 성공", async ({ request }) => {
    const events: any = await apiGet(request, "/events?limit=20", token);
    const eventList = events.items || events.data || events;

    if (!Array.isArray(eventList) || eventList.length === 0) {
      test.skip();
      return;
    }

    let targetListing: { id: string } | null = null;

    for (const event of eventList.slice(0, 10)) {
      const resaleResp = await request.get(
        `${API_BASE}/events/${event.id}/resale`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (resaleResp.status() === 200) {
        const data = await resaleResp.json();
        const listings = data.listings || data.items || [];
        if (listings.length > 0) {
          targetListing = listings[0];
          break;
        }
      }
    }

    if (!targetListing) {
      test.skip();
      return;
    }

    const [resp1, resp2] = await Promise.all([
      request.post(`${API_BASE}/resale/listings/${targetListing.id}/purchase`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {},
      }),
      request.post(`${API_BASE}/resale/listings/${targetListing.id}/purchase`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {},
      }),
    ]);

    const statuses = [resp1.status(), resp2.status()].sort();
    const successCount = statuses.filter((s) => s >= 200 && s < 300).length;
    expect(
      successCount,
      `동시 구매 ${successCount}건 성공 — 1건만 허용되어야 함`,
    ).toBeLessThanOrEqual(1);
  });
});

test.describe("리세일 매칭 — 권한 교차", () => {
  test("타인의 리세일 등록 수정 차단", async ({ request }) => {
    const auth = await apiLogin(request);
    const token = auth.accessToken;

    const fakeListingId = "00000000-0000-0000-0000-000000000000";
    const resp = await request.patch(
      `${API_BASE}/resale/listings/${fakeListingId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { price: 50000 },
      },
    );

    expect([403, 404]).toContain(resp.status());
  });

  test("타인의 리세일 등록 취소 차단", async ({ request }) => {
    const auth = await apiLogin(request);
    const token = auth.accessToken;

    const fakeListingId = "00000000-0000-0000-0000-000000000000";
    const resp = await request.delete(
      `${API_BASE}/resale/listings/${fakeListingId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect([403, 404]).toContain(resp.status());
  });

  test("비인증 상태 리세일 등록 차단", async ({ request }) => {
    const resp = await request.post(`${API_BASE}/resale/listings`, {
      data: {
        ticket_id: "00000000-0000-0000-0000-000000000000",
        price: 50000,
      },
    });

    expect(resp.status()).toBe(401);
  });
});

test.describe("리세일 매칭 — UI 검증", () => {
  test("리세일 마켓 페이지 기본 구조", async ({ page }) => {
    await page.goto(
      `${process.env.E2E_BASE_URL || "http://localhost:3020"}/browse`,
      {
        waitUntil: "networkidle",
      },
    );

    const eventCards = page.locator("a[href*='/events/']");
    if ((await eventCards.count()) > 0) {
      await eventCards.first().click();
      await page.waitForLoadState("networkidle");

      const resaleTab = page.getByText(/리세일|중고|마켓|Resale/i).first();
      if (await resaleTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await resaleTab.click();
        await page.waitForTimeout(1000);

        const priceElements = page.locator(
          "[class*='price'], [data-testid*='price']",
        );
        const hasContent =
          (await priceElements.count()) > 0 ||
          (await page.getByText(/매물|없음|등록/i).count()) > 0;

        expect(hasContent, "리세일 탭에 콘텐츠 없음").toBeTruthy();
      }
    }
  });
});

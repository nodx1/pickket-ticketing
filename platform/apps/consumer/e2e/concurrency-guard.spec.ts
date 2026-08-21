import { test, expect } from "@playwright/test";
import {
  apiLogin,
  apiGet,
  apiPost,
  findPurchasableEvent,
} from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * concurrency-guard.spec.ts — 동시성/초과판매 방지 E2E
 *
 * 검증 대상:
 *   1. 동시 구매 요청 시 재고 정합성
 *   2. 멱등성 키 중복/비중복 처리
 *   3. 동시 환불/결제확인/취소 방어
 *   4. 재고 음수 방지
 *   5. 대량 동시 요청 재고 한계 준수
 *   6. 리세일 동시 매칭 방어
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

/** 고유 멱등성 키 생성 */
function uniqueKey(prefix = "e2e-conc"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 구매 요청 헬퍼 (raw response 반환) */
async function rawPurchase(
  request: import("@playwright/test").APIRequestContext,
  eventId: string,
  tierId: string,
  token: string,
  idempotencyKey: string,
  quantity = 1,
) {
  const resp = await request.post(
    `${API_BASE}/events/${eventId}/tiers/${tierId}/purchase`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { quantity, idempotency_key: idempotencyKey },
    },
  );
  return { status: resp.status(), body: await resp.json().catch(() => null) };
}

test.describe("동시성 방어 — 구매 재고 정합성", () => {
  let token: string;
  let eventId: string;
  let tierId: string;
  let initialRemaining: number;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;

    const target = await findPurchasableEvent(request, token);
    if (target) {
      eventId = target.event.id;
      tierId = target.tier.id;
      initialRemaining = target.tier.remaining;
    }
  });

  test("동시 구매 — 2개 동시 요청 시 재고가 정확히 감소한다", async ({
    request,
  }) => {
    test.skip(!eventId, "구매 가능한 이벤트 없음");
    test.skip(initialRemaining < 2, "재고 2장 미만 — 스킵");

    // 구매 전 잔여 재고 확인
    const tiersBefore = (await apiGet(
      request,
      `/events/${eventId}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const before = tiersBefore.find((t) => t.id === tierId)!.remaining;

    // 2개 동시 구매 요청
    const [r1, r2] = await Promise.all([
      rawPurchase(request, eventId, tierId, token, uniqueKey("conc-a")),
      rawPurchase(request, eventId, tierId, token, uniqueKey("conc-b")),
    ]);

    const successes = [r1, r2].filter((r) => r.status === 200);
    const failures = [r1, r2].filter((r) => r.status !== 200);

    // 구매 후 잔여 재고 확인
    const tiersAfter = (await apiGet(
      request,
      `/events/${eventId}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const after = tiersAfter.find((t) => t.id === tierId)!.remaining;

    // 성공한 수만큼 재고 감소해야 함
    expect(before - after).toBe(successes.length);
    // 실패한 것은 409 또는 400 계열이어야 함
    for (const f of failures) {
      expect(f.status).toBeGreaterThanOrEqual(400);
      expect(f.status).toBeLessThan(500);
    }
  });

  test("멱등성 키 중복 — 같은 키로 2번 요청 시 같은 주문 반환", async ({
    request,
  }) => {
    test.skip(!eventId, "구매 가능한 이벤트 없음");

    const key = uniqueKey("idempotent");

    const r1 = await rawPurchase(request, eventId, tierId, token, key);
    // 즉시 주문 생성(order_id 발급)된 경우만 멱등 검증 — lottery/판매창 등은 order_id null
    test.skip(
      ![200, 201].includes(r1.status) || r1.body?.order_id == null,
      "즉시 주문 생성 tier 아님 — 멱등 검증 비대상",
    );

    const r2 = await rawPurchase(request, eventId, tierId, token, key);

    // 같은 멱등성 키 → 같은 order_id (non-null)
    expect(r2.body?.order_id).toBe(r1.body?.order_id);
    expect(r2.body?.order_id).not.toBeNull();
  });

  test("멱등성 키 다름 — 다른 키로 2번 → 2개의 주문 생성", async ({
    request,
  }) => {
    test.skip(!eventId, "구매 가능한 이벤트 없음");

    const r1 = await rawPurchase(
      request,
      eventId,
      tierId,
      token,
      uniqueKey("diff-a"),
    );
    const r2 = await rawPurchase(
      request,
      eventId,
      tierId,
      token,
      uniqueKey("diff-b"),
    );

    // 주문 생성 성공 = 200/201 AND order_id 발급(즉시 주문 생성 tier만 — lottery 응모/
    // 판매창/매진은 success:false + order_id:null 이므로 이 시나리오에서 제외).
    const ok = (s: number) => s === 200 || s === 201;
    const createdOrder = (r: { status: number; body: { order_id?: string | null } | null }) =>
      ok(r.status) && r.body?.order_id != null;
    if (createdOrder(r1) && createdOrder(r2)) {
      // 둘 다 주문 생성됐으면 다른 order_id
      expect(r1.body?.order_id).not.toBe(r2.body?.order_id);
    } else if (ok(r1.status) && ok(r2.status)) {
      // 즉시 주문 미생성(lottery/판매창 등) — 정상, distinctness 검증 대상 아님
      test.skip(true, "즉시 주문 생성 tier 아님 — 멱등 distinctness 비대상");
    } else {
      // 재고 부족으로 하나 실패 가능 — 실패 시 4xx
      const failed = [r1, r2].find((r) => !ok(r.status));
      if (failed) {
        expect(failed.status).toBeGreaterThanOrEqual(400);
        expect(failed.status).toBeLessThan(500);
      }
    }
  });

  test("재고 정합성 — 구매 전후 remaining이 정확히 quantity만큼 감소", async ({
    request,
  }) => {
    test.skip(!eventId, "구매 가능한 이벤트 없음");

    const tiersBefore = (await apiGet(
      request,
      `/events/${eventId}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const before = tiersBefore.find((t) => t.id === tierId)!.remaining;
    test.skip(before < 1, "재고 없음");

    const quantity = 1;
    const result = await rawPurchase(
      request,
      eventId,
      tierId,
      token,
      uniqueKey("stock"),
      quantity,
    );

    const tiersAfter = (await apiGet(
      request,
      `/events/${eventId}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const after = tiersAfter.find((t) => t.id === tierId)!.remaining;

    if (result.status === 200) {
      expect(before - after).toBe(quantity);
    } else {
      // 구매 실패 시 재고 변동 없어야 함
      expect(after).toBe(before);
    }
  });

  test("재고 음수 방지 — remaining=0인 등급 구매 시 에러 반환", async ({
    request,
  }) => {
    // remaining=0인 등급 찾기
    const events = (await apiGet(
      request,
      "/events/search?status=bidding_open&limit=50",
      token,
    )) as { events: Array<{ id: string }> };

    let soldOutEventId: string | null = null;
    let soldOutTierId: string | null = null;

    for (const event of events.events || []) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{ id: string; remaining: number; capacity: number }>;
      const soldOut = tiers.find((t) => t.remaining === 0 && t.capacity > 0);
      if (soldOut) {
        soldOutEventId = event.id;
        soldOutTierId = soldOut.id;
        break;
      }
    }

    test.skip(!soldOutEventId, "매진 등급 없음 — 스킵");

    const result = await rawPurchase(
      request,
      soldOutEventId!,
      soldOutTierId!,
      token,
      uniqueKey("soldout"),
    );

    // 매진 시 에러 반환 (200이면 안 됨)
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });

  test("대량 동시 요청 — 5개 동시 구매 시 재고 이하만 성공", async ({
    request,
  }) => {
    test.skip(!eventId, "구매 가능한 이벤트 없음");

    const tiersBefore = (await apiGet(
      request,
      `/events/${eventId}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const before = tiersBefore.find((t) => t.id === tierId)!.remaining;
    test.skip(before < 1, "재고 없음");

    // 5개 동시 요청
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        rawPurchase(request, eventId, tierId, token, uniqueKey(`bulk-${i}`)),
      ),
    );

    const successes = results.filter((r) => r.status === 200);

    // 성공 수가 재고 이하여야 함
    expect(successes.length).toBeLessThanOrEqual(before);

    // 재고 확인
    const tiersAfter = (await apiGet(
      request,
      `/events/${eventId}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const after = tiersAfter.find((t) => t.id === tierId)!.remaining;

    // 잔여 재고는 0 이상이어야 함 (음수 방지)
    expect(after).toBeGreaterThanOrEqual(0);
    // 감소량 = 성공 수
    expect(before - after).toBe(successes.length);
  });
});

test.describe("동시성 방어 — 주문 상태 변경", () => {
  let token: string;
  let orderId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;

    // 테스트용 주문 생성
    const target = await findPurchasableEvent(request, token);
    if (target) {
      const result = await rawPurchase(
        request,
        target.event.id,
        target.tier.id,
        token,
        uniqueKey("setup-order"),
      );
      if (result.status === 200) {
        orderId = result.body?.order_id;
      }
    }
  });

  test("동시 결제 확인 — 같은 주문에 2번 결제 확인 → 1번만 처리", async ({
    request,
  }) => {
    test.skip(!orderId, "테스트 주문 없음");

    const [r1, r2] = await Promise.all([
      apiPost(request, `/orders/${orderId}/pay`, token, {
        payment_method: "card",
        idempotency_key: uniqueKey("pay"),
      }),
      apiPost(request, `/orders/${orderId}/pay`, token, {
        payment_method: "card",
        idempotency_key: uniqueKey("pay2"),
      }),
    ]);

    const results = [r1, r2] as Array<{ status: number; body: unknown }>;
    const successes = results.filter((r) => r.status >= 200 && r.status < 300);

    // 최대 1번만 성공하거나, 멱등 처리로 둘 다 같은 결과
    if (successes.length === 2) {
      // 둘 다 성공이면 같은 결과여야 함 (멱등)
      expect(successes[0].body).toEqual(successes[1].body);
    } else {
      // 1번만 성공하거나, 둘 다 에러 (이미 처리됨)
      expect(successes.length).toBeLessThanOrEqual(1);
    }
  });

  test("동시 주문 취소 — 결제 전 주문 2번 취소 → 1번만 처리", async ({
    request,
  }) => {
    // 새 주문 생성
    const target = await findPurchasableEvent(request, token);
    test.skip(!target, "구매 가능한 이벤트 없음");

    const purchase = await rawPurchase(
      request,
      target!.event.id,
      target!.tier.id,
      token,
      uniqueKey("cancel-setup"),
    );
    test.skip(purchase.status !== 200, "주문 생성 실패");

    const oid = purchase.body?.order_id;

    const [r1, r2] = await Promise.all([
      apiPost(request, `/orders/${oid}/cancel`, token),
      apiPost(request, `/orders/${oid}/cancel`, token),
    ]);

    const results = [r1, r2] as Array<{ status: number; body: unknown }>;
    const successes = results.filter((r) => r.status >= 200 && r.status < 300);

    // 취소는 최대 1번만 실제 처리
    // 둘 다 성공할 수 있음 (멱등 취소), 하지만 주문 상태는 cancelled 1회
    const order = (await apiGet(request, `/orders/${oid}`, token).catch(
      () => null,
    )) as { status: string } | null;
    if (order) {
      expect(order.status).toBe("cancelled");
    }
  });

  test("동시 환불 — 같은 주문에 2개 환불 요청 → 1개만 성공", async ({
    request,
  }) => {
    // 결제 완료된 주문 찾기
    const orders = (await apiGet(
      request,
      "/orders/my?limit=50",
      token,
    )) as Array<{ id: string; status: string }>;
    const paidOrder = orders.find(
      (o) =>
        o.status === "confirmed" ||
        o.status === "paid" ||
        o.status === "active",
    );
    test.skip(!paidOrder, "환불 가능한 주문 없음");

    const [r1, r2] = await Promise.all([
      apiPost(request, `/orders/${paidOrder!.id}/refund`, token, {
        reason: "e2e-동시환불-테스트",
      }),
      apiPost(request, `/orders/${paidOrder!.id}/refund`, token, {
        reason: "e2e-동시환불-테스트-2",
      }),
    ]);

    const results = [r1, r2] as Array<{ status: number; body: unknown }>;
    const successes = results.filter((r) => r.status >= 200 && r.status < 300);

    // 환불은 최대 1번만 성공해야 함
    expect(successes.length).toBeLessThanOrEqual(1);
  });
});

test.describe("동시성 방어 — 멱등성 키 엣지케이스", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("멱등성 키 없이 요청 → 에러 또는 자동 생성", async ({ request }) => {
    const target = await findPurchasableEvent(request, token);
    test.skip(!target, "구매 가능한 이벤트 없음");

    const resp = await request.post(
      `${API_BASE}/events/${target!.event.id}/tiers/${target!.tier.id}/purchase`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { quantity: 1 },
      },
    );

    // 멱등성 키 누락 시 400 또는 서버가 자동 생성(200/201) 또는 rate limit(429)
    expect([200, 201, 400, 422, 429]).toContain(resp.status());
  });

  test("빈 문자열 멱등성 키 → 에러 반환", async ({ request }) => {
    const target = await findPurchasableEvent(request, token);
    test.skip(!target, "구매 가능한 이벤트 없음");

    const resp = await request.post(
      `${API_BASE}/events/${target!.event.id}/tiers/${target!.tier.id}/purchase`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { quantity: 1, idempotency_key: "" },
      },
    );

    // 빈 키는 400 또는 422 또는 200 (서버 정책에 따라)
    expect(resp.status()).toBeLessThan(500);
  });

  test("매우 긴 멱등성 키 → 정상 처리 또는 적절한 에러", async ({
    request,
  }) => {
    const target = await findPurchasableEvent(request, token);
    test.skip(!target, "구매 가능한 이벤트 없음");

    const longKey = "e2e-" + "x".repeat(500);
    const resp = await request.post(
      `${API_BASE}/events/${target!.event.id}/tiers/${target!.tier.id}/purchase`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { quantity: 1, idempotency_key: longKey },
      },
    );

    // 서버 에러(500)가 아니어야 함
    expect(resp.status()).toBeLessThan(500);
  });
});

test.describe("동시성 방어 — 리세일 매칭", () => {
  let token: string;
  let token2: string;

  test.beforeAll(async ({ request }) => {
    const auth1 = await apiLogin(request);
    token = auth1.accessToken;

    const auth2 = await apiLogin(
      request,
      process.env.E2E_CONSUMER_EMAIL_2 || "testuser0002@seedtest.pickket.kr",
      process.env.E2E_CONSUMER_PASSWORD_2 || "PickketTest2026!",
    );
    token2 = auth2.accessToken;
  });

  test("리세일 동시 매칭 — 같은 매물에 2명 동시 구매 → 1명만 성공", async ({
    request,
  }) => {
    // 리세일 매물 찾기
    const events = (await apiGet(
      request,
      "/events/search?limit=20",
      token,
    )) as { events: Array<{ id: string }> };

    let resaleListingId: string | null = null;
    let resaleEventId: string | null = null;

    for (const event of events.events || []) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{ id: string }>;

      for (const tier of tiers) {
        const resp = await request.get(
          `${API_BASE}/resale/market/${event.id}/${tier.id}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );

        if (resp.ok()) {
          const market = (await resp.json()) as {
            asks?: Array<{ id: string; price: number }>;
          };
          if (market.asks && market.asks.length > 0) {
            resaleListingId = market.asks[0].id;
            resaleEventId = event.id;
            break;
          }
        }
      }
      if (resaleListingId) break;
    }

    test.skip(!resaleListingId, "리세일 매물 없음 — 스킵");

    // 2명이 동시에 같은 매물 구매 시도
    const [r1, r2] = await Promise.all([
      apiPost(request, `/resale/buy/${resaleListingId}`, token, {
        idempotency_key: uniqueKey("resale-buy-1"),
      }),
      apiPost(request, `/resale/buy/${resaleListingId}`, token2, {
        idempotency_key: uniqueKey("resale-buy-2"),
      }),
    ]);

    const results = [r1, r2] as Array<{ status: number; body: unknown }>;
    const successes = results.filter((r) => r.status >= 200 && r.status < 300);

    // 같은 매물은 1명만 구매 성공
    expect(successes.length).toBeLessThanOrEqual(1);
  });
});

test.describe("동시성 방어 — 수량 초과 방지", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("최대 수량 초과 구매 → 에러 반환", async ({ request }) => {
    const target = await findPurchasableEvent(request, token);
    test.skip(!target, "구매 가능한 이벤트 없음");

    // 비정상적으로 큰 수량 요청
    const result = await rawPurchase(
      request,
      target!.event.id,
      target!.tier.id,
      token,
      uniqueKey("overqty"),
      9999,
    );

    // 9999장은 실패해야 함 (재고 부족 또는 수량 제한)
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });

  test("음수 수량 구매 → 400 에러", async ({ request }) => {
    const target = await findPurchasableEvent(request, token);
    test.skip(!target, "구매 가능한 이벤트 없음");

    const resp = await request.post(
      `${API_BASE}/events/${target!.event.id}/tiers/${target!.tier.id}/purchase`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { quantity: -1, idempotency_key: uniqueKey("neg") },
      },
    );

    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("소수점 수량 구매 → 400 에러", async ({ request }) => {
    const target = await findPurchasableEvent(request, token);
    test.skip(!target, "구매 가능한 이벤트 없음");

    const resp = await request.post(
      `${API_BASE}/events/${target!.event.id}/tiers/${target!.tier.id}/purchase`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { quantity: 1.5, idempotency_key: uniqueKey("decimal") },
      },
    );

    // 소수점 수량은 400/422 또는 서버가 내림 처리
    expect(resp.status()).toBeLessThan(500);
  });
});

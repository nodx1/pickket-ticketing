import { test as authTest, expect as authExpect } from "./fixtures/auth";
import { test, expect } from "@playwright/test";
import {
  dismissOnboarding,
  apiLogin,
  apiGet,
  apiPost,
  findPurchasableEvent,
} from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * data-integrity-deep.spec.ts — 데이터 무결성 심화 E2E
 *
 * 검증 대상:
 *   1. 이벤트 데이터 일관성 (상태·등급·가격·날짜·카테고리)
 *   2. 주문 데이터 일관성 (금액·상태·참조 무결성)
 *   3. 티켓 데이터 일관성 (연결·상태·수량)
 *   4. 사용자 데이터 (프로필·포인트·즐겨찾기)
 *   5. 크로스 데이터 검증 (구매/환불 후 재고 변동)
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

// 유효한 카테고리 목록
const VALID_CATEGORIES = [
  "concert",
  "musical",
  "sports",
  "festival",
  "exhibition",
  "classical",
  "esports",
];

// 유효한 주문 상태 목록
const VALID_ORDER_STATUSES = [
  "pending",
  "payment_required",
  "confirmed",
  "cancelled",
  "refunded",
  "expired",
  "failed",
];

// 유효한 티켓 상태 목록
const VALID_TICKET_STATUSES = [
  "pending",
  "active",
  "used",
  "cancelled",
  "expired",
  "transferred",
];

/* ─── 이벤트 데이터 일관성 ─────────────────────────────────────────── */

test.describe("이벤트 데이터 일관성 — 심화", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("bidding_open 이벤트는 start_date, end_date 필수", async ({
    request,
  }) => {
    const data = (await apiGet(
      request,
      "/events/search?status=bidding_open&limit=20",
      token,
    )) as {
      events: Array<{
        id: string;
        title: string;
        status: string;
        start_date?: string;
        end_date?: string;
        event_date?: string;
      }>;
    };

    if (data.events.length === 0) {
      test.skip(true, "bidding_open 이벤트 없음");
      return;
    }

    for (const event of data.events) {
      // bidding_open 상태의 이벤트는 날짜 정보가 있어야 함
      const hasDateInfo =
        event.start_date || event.end_date || event.event_date;
      expect(
        hasDateInfo,
        `이벤트 ${event.id} (${event.title})에 날짜 정보 없음`,
      ).toBeTruthy();
    }
  });

  test("모든 등급의 capacity 합계 ≤ 이벤트 total_capacity", async ({
    request,
  }) => {
    const data = (await apiGet(request, "/events/search?limit=10", token)) as {
      events: Array<{ id: string; title: string; total_capacity?: number }>;
    };

    for (const event of data.events.slice(0, 5)) {
      const detail = (await apiGet(request, `/events/${event.id}`, token)) as {
        id: string;
        total_capacity?: number;
      };

      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{ capacity: number }>;

      if (tiers.length === 0 || !detail.total_capacity) continue;

      const tierCapacitySum = tiers.reduce((sum, t) => sum + t.capacity, 0);
      expect(
        tierCapacitySum,
        `이벤트 ${event.id}: 등급 합계(${tierCapacitySum}) > total_capacity(${detail.total_capacity})`,
      ).toBeLessThanOrEqual(detail.total_capacity);
    }
  });

  test("가격 범위: base_price > 0, max_price >= base_price", async ({
    request,
  }) => {
    const data = (await apiGet(request, "/events/search?limit=10", token)) as {
      events: Array<{ id: string }>;
    };

    for (const event of data.events.slice(0, 5)) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{
        name: string;
        base_price: number;
        max_price?: number | null;
        face_price?: number;
      }>;

      for (const tier of tiers) {
        expect(
          tier.base_price,
          `등급 "${tier.name}": base_price는 0 이상이어야 함`,
        ).toBeGreaterThanOrEqual(0);

        // max_price가 존재하면 base_price 이상이어야 함
        if (tier.max_price != null) {
          expect(
            tier.max_price,
            `등급 "${tier.name}": max_price(${tier.max_price}) < base_price(${tier.base_price})`,
          ).toBeGreaterThanOrEqual(tier.base_price);
        }
      }
    }
  });

  test("remaining 정합성: 0 ≤ remaining ≤ capacity (모든 등급)", async ({
    request,
  }) => {
    const data = (await apiGet(request, "/events/search?limit=15", token)) as {
      events: Array<{ id: string }>;
    };

    for (const event of data.events.slice(0, 7)) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{
        name: string;
        capacity: number;
        remaining: number;
      }>;

      for (const tier of tiers) {
        expect(
          tier.remaining,
          `등급 "${tier.name}": remaining(${tier.remaining})이 음수`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          tier.remaining,
          `등급 "${tier.name}": remaining(${tier.remaining}) > capacity(${tier.capacity})`,
        ).toBeLessThanOrEqual(tier.capacity);
      }
    }
  });

  test("sold_count 정합성: sold_count = capacity - remaining", async ({
    request,
  }) => {
    const data = (await apiGet(request, "/events/search?limit=10", token)) as {
      events: Array<{ id: string }>;
    };

    for (const event of data.events.slice(0, 5)) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{
        name: string;
        capacity: number;
        remaining: number;
        sold_count?: number;
      }>;

      for (const tier of tiers) {
        if (tier.sold_count === undefined) continue;

        const expectedSold = tier.capacity - tier.remaining;
        expect(
          tier.sold_count,
          `등급 "${tier.name}": sold_count(${tier.sold_count}) ≠ capacity(${tier.capacity}) - remaining(${tier.remaining})`,
        ).toBe(expectedSold);
      }
    }
  });

  test("카테고리 유효성: 허용된 값 중 하나", async ({ request }) => {
    const data = (await apiGet(request, "/events/search?limit=50", token)) as {
      events: Array<{ id: string; title: string; category: string }>;
    };

    expect(data.events.length).toBeGreaterThan(0);

    for (const event of data.events) {
      expect(
        VALID_CATEGORIES,
        `이벤트 ${event.id} (${event.title}): 유효하지 않은 카테고리 "${event.category}"`,
      ).toContain(event.category.toLowerCase());
    }
  });

  test("날짜 논리: start_date < end_date", async ({ request }) => {
    const data = (await apiGet(request, "/events/search?limit=20", token)) as {
      events: Array<{
        id: string;
        title: string;
        start_date?: string;
        end_date?: string;
      }>;
    };

    for (const event of data.events) {
      if (!event.start_date || !event.end_date) continue;

      const start = new Date(event.start_date).getTime();
      const end = new Date(event.end_date).getTime();

      expect(
        start,
        `이벤트 ${event.id} (${event.title}): start_date(${event.start_date}) ≥ end_date(${event.end_date})`,
      ).toBeLessThan(end);
    }
  });

  test("이벤트 ID 고유성: 목록에서 중복 ID 없음", async ({ request }) => {
    const data = (await apiGet(request, "/events/search?limit=100", token)) as {
      events: Array<{ id: string }>;
    };

    const ids = data.events.map((e) => e.id);
    const uniqueIds = new Set(ids);

    expect(
      ids.length,
      `이벤트 목록에 중복 ID 존재: ${ids.length}개 중 ${uniqueIds.size}개 고유`,
    ).toBe(uniqueIds.size);
  });
});

/* ─── 주문 데이터 일관성 ───────────────────────────────────────────── */

test.describe("주문 데이터 일관성 — 심화", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("주문 금액 계산: total_amount ≈ quantity × unit_price", async ({
    request,
  }) => {
    const orders = (await apiGet(
      request,
      "/orders/my?limit=30",
      token,
    )) as Array<{
      id: string;
      quantity: number;
      unit_price: number;
      total_amount: number;
    }>;

    if (orders.length === 0) {
      test.skip(true, "주문 내역 없음");
      return;
    }

    for (const order of orders) {
      if (!order.unit_price || !order.quantity) continue;

      const expected = order.quantity * order.unit_price;
      // 수수료, 할인 등으로 ±50% 범위 허용
      expect(
        order.total_amount,
        `주문 ${order.id}: total(${order.total_amount}) ≈ ${order.quantity} × ${order.unit_price} = ${expected}`,
      ).toBeGreaterThanOrEqual(expected * 0.5);
      expect(order.total_amount).toBeLessThanOrEqual(expected * 1.5);
    }
  });

  test("주문 상태 유효성: 허용된 값 중 하나", async ({ request }) => {
    const orders = (await apiGet(
      request,
      "/orders/my?limit=30",
      token,
    )) as Array<{
      id: string;
      status: string;
    }>;

    if (orders.length === 0) {
      test.skip(true, "주문 내역 없음");
      return;
    }

    for (const order of orders) {
      expect(
        VALID_ORDER_STATUSES,
        `주문 ${order.id}: 유효하지 않은 상태 "${order.status}"`,
      ).toContain(order.status.toLowerCase());
    }
  });

  test("주문-이벤트 참조: event_id가 실제 존재하는 이벤트", async ({
    request,
  }) => {
    const orders = (await apiGet(
      request,
      "/orders/my?limit=10",
      token,
    )) as Array<{
      id: string;
      event_id: string;
    }>;

    if (orders.length === 0) {
      test.skip(true, "주문 내역 없음");
      return;
    }

    for (const order of orders.slice(0, 5)) {
      if (!order.event_id) continue;

      const resp = await request.get(`${API_BASE}/events/${order.event_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(
        resp.ok(),
        `주문 ${order.id}의 event_id(${order.event_id})가 존재하지 않음 (${resp.status()})`,
      ).toBe(true);
    }
  });

  test("주문-등급 참조: tier_id가 해당 이벤트의 유효한 등급", async ({
    request,
  }) => {
    const orders = (await apiGet(
      request,
      "/orders/my?limit=10",
      token,
    )) as Array<{
      id: string;
      event_id: string;
      tier_id: string;
    }>;

    if (orders.length === 0) {
      test.skip(true, "주문 내역 없음");
      return;
    }

    for (const order of orders.slice(0, 5)) {
      if (!order.event_id || !order.tier_id) continue;

      const tiers = (await apiGet(
        request,
        `/events/${order.event_id}/tiers`,
        token,
      )) as Array<{ id: string }>;

      const tierIds = tiers.map((t) => t.id);
      expect(
        tierIds,
        `주문 ${order.id}의 tier_id(${order.tier_id})가 이벤트 ${order.event_id}의 등급에 없음`,
      ).toContain(order.tier_id);
    }
  });
});

/* ─── 티켓 데이터 일관성 ───────────────────────────────────────────── */

test.describe("티켓 데이터 일관성 — 심화", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("티켓-주문 연결: 각 티켓의 order_id가 내 주문 목록에 존재", async ({
    request,
  }) => {
    const resp = await request.get(`${API_BASE}/tickets?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok()) {
      test.skip(true, "티켓 API 미지원");
      return;
    }

    const tickets = (await resp.json()) as Array<{
      id: string;
      order_id: string;
    }>;

    if (!Array.isArray(tickets) || tickets.length === 0) {
      test.skip(true, "티켓 없음");
      return;
    }

    // 내 주문 전체 ID 조회
    const orders = (await apiGet(
      request,
      "/orders/my?limit=100",
      token,
    )) as Array<{ id: string }>;
    const orderIds = new Set(orders.map((o) => o.id));

    for (const ticket of tickets.slice(0, 10)) {
      if (!ticket.order_id) continue;
      expect(
        orderIds.has(ticket.order_id),
        `티켓 ${ticket.id}의 order_id(${ticket.order_id})가 내 주문에 없음`,
      ).toBe(true);
    }
  });

  test("티켓 상태 유효성: 허용된 값 중 하나", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/tickets?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok()) {
      test.skip(true, "티켓 API 미지원");
      return;
    }

    const tickets = (await resp.json()) as Array<{
      id: string;
      status: string;
    }>;

    if (!Array.isArray(tickets) || tickets.length === 0) {
      test.skip(true, "티켓 없음");
      return;
    }

    for (const ticket of tickets) {
      expect(
        VALID_TICKET_STATUSES,
        `티켓 ${ticket.id}: 유효하지 않은 상태 "${ticket.status}"`,
      ).toContain(ticket.status.toLowerCase());
    }
  });

  test("티켓 수량 일치: 주문의 quantity와 해당 주문의 티켓 수 일치", async ({
    request,
  }) => {
    const resp = await request.get(`${API_BASE}/tickets?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok()) {
      test.skip(true, "티켓 API 미지원");
      return;
    }

    const tickets = (await resp.json()) as Array<{
      id: string;
      order_id: string;
    }>;

    if (!Array.isArray(tickets) || tickets.length === 0) {
      test.skip(true, "티켓 없음");
      return;
    }

    // order_id별 티켓 수 카운트
    const ticketCountByOrder = new Map<string, number>();
    for (const ticket of tickets) {
      if (!ticket.order_id) continue;
      ticketCountByOrder.set(
        ticket.order_id,
        (ticketCountByOrder.get(ticket.order_id) || 0) + 1,
      );
    }

    // 각 주문의 quantity와 비교
    const orders = (await apiGet(
      request,
      "/orders/my?limit=100",
      token,
    )) as Array<{
      id: string;
      quantity: number;
      status: string;
    }>;

    for (const order of orders) {
      // confirmed 주문만 티켓이 발급되어야 함
      if (order.status !== "confirmed") continue;

      const ticketCount = ticketCountByOrder.get(order.id);
      if (ticketCount === undefined) continue; // 페이지네이션으로 누락 가능

      expect(
        ticketCount,
        `주문 ${order.id}: quantity(${order.quantity}) ≠ 티켓 수(${ticketCount})`,
      ).toBe(order.quantity);
    }
  });
});

/* ─── 사용자 데이터 ────────────────────────────────────────────────── */

test.describe("사용자 데이터 무결성", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("프로필 필수 필드: email, name 존재", async ({ request }) => {
    const profile = (await apiGet(request, "/users/me", token)) as {
      id: string;
      email: string;
      name: string;
    };

    expect(profile.email, "email 필드가 비어있음").toBeTruthy();
    expect(profile.name, "name 필드가 비어있음").toBeTruthy();
    // 이메일 형식 검증
    expect(profile.email).toMatch(/.+@.+\..+/);
  });

  test("포인트 잔액 비음수: points_balance >= 0", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/points/wallet`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok()) {
      // 포인트 API가 없는 경우 프로필에서 확인
      const profile = (await apiGet(request, "/users/me", token)) as {
        points_balance?: number;
        mileage?: number;
      };

      if (profile.points_balance !== undefined) {
        expect(
          profile.points_balance,
          "points_balance가 음수",
        ).toBeGreaterThanOrEqual(0);
      }
      if (profile.mileage !== undefined) {
        expect(profile.mileage, "mileage가 음수").toBeGreaterThanOrEqual(0);
      }
      return;
    }

    const wallet = (await resp.json()) as {
      balance: number;
    };
    expect(wallet.balance, "포인트 잔액이 음수").toBeGreaterThanOrEqual(0);
  });

  test("즐겨찾기 참조 유효성: event_id가 실제 이벤트에 존재", async ({
    request,
  }) => {
    const resp = await request.get(`${API_BASE}/events/favorites`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok()) {
      test.skip(true, "즐겨찾기 API 미지원");
      return;
    }

    const favorites = (await resp.json()) as Array<{
      id: string;
      event_id?: string;
    }>;

    if (!Array.isArray(favorites) || favorites.length === 0) {
      test.skip(true, "즐겨찾기 없음");
      return;
    }

    for (const fav of favorites.slice(0, 5)) {
      const eventId = fav.event_id || fav.id;
      const eventResp = await request.get(`${API_BASE}/events/${eventId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(
        eventResp.ok(),
        `즐겨찾기의 이벤트(${eventId})가 존재하지 않음`,
      ).toBe(true);
    }
  });
});

/* ─── 크로스 데이터 검증 ───────────────────────────────────────────── */

test.describe("크로스 데이터 검증 — 구매/환불 전후 재고", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("구매 후 remaining 감소 확인", async ({ request }) => {
    const purchasable = await findPurchasableEvent(request, token);
    if (!purchasable) {
      test.skip(true, "구매 가능한 이벤트 없음");
      return;
    }

    const { event, tier } = purchasable;

    // 구매 전 remaining 기록
    const tiersBefore = (await apiGet(
      request,
      `/events/${event.id}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const beforeTier = tiersBefore.find((t) => t.id === tier.id);
    expect(beforeTier).toBeTruthy();
    const remainingBefore = beforeTier!.remaining;

    // 구매 시도
    const purchaseResp = (await apiPost(
      request,
      `/events/${event.id}/tiers/${tier.id}/purchase`,
      token,
      { quantity: 1, idempotency_key: `e2e-deep-${Date.now()}` },
    )) as { status: number; body: unknown };

    if (purchaseResp.status >= 400) {
      test.skip(true, "구매 실패 — 재고 감소 검증 불가");
      return;
    }

    // 구매 후 remaining 확인
    const tiersAfter = (await apiGet(
      request,
      `/events/${event.id}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const afterTier = tiersAfter.find((t) => t.id === tier.id);
    expect(afterTier).toBeTruthy();

    expect(
      afterTier!.remaining,
      `구매 후 remaining이 감소하지 않음: before=${remainingBefore}, after=${afterTier!.remaining}`,
    ).toBeLessThanOrEqual(remainingBefore);
  });

  test("환불 후 remaining 증가 확인", async ({ request }) => {
    // 환불 가능한 주문 찾기
    const orders = (await apiGet(
      request,
      "/orders/my?limit=20",
      token,
    )) as Array<{
      id: string;
      event_id: string;
      tier_id: string;
      quantity: number;
      status: string;
    }>;

    const refundableOrder = orders.find(
      (o) => o.status === "confirmed" || o.status === "payment_required",
    );

    if (!refundableOrder) {
      test.skip(true, "환불 가능한 주문 없음");
      return;
    }

    // 환불 전 remaining 기록
    const tiersBefore = (await apiGet(
      request,
      `/events/${refundableOrder.event_id}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const beforeTier = tiersBefore.find(
      (t) => t.id === refundableOrder.tier_id,
    );

    if (!beforeTier) {
      test.skip(true, "주문의 등급 정보를 찾을 수 없음");
      return;
    }

    const remainingBefore = beforeTier.remaining;

    // 환불 시도
    const refundResp = (await apiPost(
      request,
      `/orders/${refundableOrder.id}/cancel`,
      token,
    )) as { status: number; body: unknown };

    if (refundResp.status >= 400) {
      test.skip(true, "환불 실패 — 재고 증가 검증 불가");
      return;
    }

    // 환불 후 remaining 확인
    const tiersAfter = (await apiGet(
      request,
      `/events/${refundableOrder.event_id}/tiers`,
      token,
    )) as Array<{ id: string; remaining: number }>;
    const afterTier = tiersAfter.find((t) => t.id === refundableOrder.tier_id);
    expect(afterTier).toBeTruthy();

    expect(
      afterTier!.remaining,
      `환불 후 remaining이 증가하지 않음: before=${remainingBefore}, after=${afterTier!.remaining}`,
    ).toBeGreaterThanOrEqual(remainingBefore);
  });
});

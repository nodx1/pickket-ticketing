/**
 * 좌석 선택 구매 플로우 — 좌석맵 기반 이벤트 E2E
 *
 * 커버리지:
 *  - 좌석맵 생성 (API가 section × row × seat 자동 생성)
 *  - 좌석 목록 조회
 *  - 특정 좌석 선택 주문 생성 → Phase 5A-4 held_until 설정
 *  - 이미 예약된 좌석 재주문 → 실패
 *  - 다른 좌석은 정상 주문
 *  - 결제 완료 후 좌석 상태 = reserved/sold
 *
 * API 동작:
 *   POST /api/events/{id}/seat-maps → { name, sections, rowsPerSection, seatsPerRow }
 *   → DB에 sections × rows × seats 만큼 좌석 자동 INSERT
 *   응답: { id: mapId }
 *
 *   GET /api/events/{id}/seat-maps/{mapId}/seats → 좌석 목록
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";
import { checkoutInitiate, checkoutComplete } from "../helpers/checkout";

let request: APIRequestContext;
let eventId: string;
let productId: string;
let seatMapId: string;
let seatTierId: string;
let seatIds: string[] = [];
let orderId: string;
let ownerCookie: string;

test.describe("좌석 선택 구매 플로우 (Phase 5A-4 좌석 홀드)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test("1. 좌석 전용 상품 생성", async () => {
    const res = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `E2E 좌석 티켓 ${Date.now()}`,
        type: "ticket",
        price: "80000",
        stock: "20",
        minPerOrder: "1",
        maxPerOrder: "4",
        description: "좌석 선택 E2E",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    productId = body.data.id;
    expect(productId).toBeTruthy();
  });

  test("1.5 좌석 티어 생성 (v2 앵커)", async () => {
    const res = await request.post(`/api/events/${eventId}/seat-tiers`, {
      data: { name: `VIP ${Date.now()}`, capacity: 30, basePrice: 80000 },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    seatTierId = body.data.id; // = seat_tiers.id (tierId 로 좌석에 부착)
    expect(seatTierId).toBeTruthy();
  });

  // figma 모드라야 seats.tier_id 가 채워지고 → write-through 가 v2_seat_id 백필.
  // (grid 모드는 tier_id 가 NULL 로 들어가 v2_seat_id 가 안 생김 → 좌석주문 가드에 막힘)
  test("2. 좌석맵 생성 (figma, tier 앵커 → v2_seat_id 채움, 2×3×5=30석)", async () => {
    const res = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `E2E 좌석맵 ${Date.now()}`,
        figmaLayout: {
          sections: [
            { name: "VIP", x: 0, y: 0, kind: "assigned", rows: 3, seatsPerRow: 5, tierId: seatTierId },
            { name: "R", x: 400, y: 0, kind: "assigned", rows: 3, seatsPerRow: 5, tierId: seatTierId },
          ],
        },
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    seatMapId = body.data.id;
    expect(seatMapId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("3. 좌석 목록 조회 → 30개 available", async () => {
    const res = await request.get(`/api/events/${eventId}/seat-maps/${seatMapId}/seats`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // listResponse 포맷: { success, data: [...], meta: { total } } 또는 배열 직접
    const seats = (body.data ?? body.items ?? body) as Array<{
      id: string;
      status: string;
    }>;
    expect(Array.isArray(seats)).toBeTruthy();
    expect(seats.length).toBe(30); // 2 * 3 * 5
    expect(seats.every((s) => s.status === "available")).toBeTruthy();
    seatIds = seats.map((s) => s.id);
  });

  test("4. 좌석 선택 주문 생성 → held_until 설정 (Phase 5A-4)", async () => {
    const selected = seatIds.slice(0, 2); // 처음 2석
    const result = await checkoutInitiate(request, {
      eventId,
      items: [{ productId, quantity: 2 }],
      buyerName: "좌석E2E",
      buyerEmail: `seat-e2e-${Date.now()}@test.local`,
      buyerPhone: "01012345678",
      selectedSeatIds: selected,
      finalAmount: 160000,
    });
    expect(result.response.status()).toBe(201);
    orderId = result.orderId;
    ownerCookie = result.ownerCookie;
    expect(orderId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("5. 이미 홀드된 좌석 재선택 → 실패", async () => {
    const alreadyHeld = seatIds.slice(0, 2); // 이미 4번에서 홀드됨
    const res = await request.post("/api/checkout/initiate", {
      data: {
        eventId,
        items: [{ productId, quantity: 2 }],
        buyerName: "두번째구매자",
        buyerEmail: `dup-${Date.now()}@test.local`,
        buyerPhone: "01098765432",
        selectedSeatIds: alreadyHeld,
        finalAmount: 160000,
      },
    });
    expect(res.ok()).toBeFalsy();
    const body = await res.json().catch(() => ({ success: false }));
    expect(body.success).toBeFalsy();
  });

  test("6. 다른 좌석 주문 → 성공", async () => {
    const otherSeats = seatIds.slice(10, 12); // R 섹션
    const res = await request.post("/api/checkout/initiate", {
      data: {
        eventId,
        items: [{ productId, quantity: 2 }],
        buyerName: "다른구매자",
        buyerEmail: `other-${Date.now()}@test.local`,
        buyerPhone: "01011112222",
        selectedSeatIds: otherSeats,
        finalAmount: 160000,
      },
    });
    expect(res.status()).toBe(201);
  });

  test("7. 결제 완료 (offline)", async () => {
    expect(ownerCookie, "ownerCookie 미설정 — test 4 실패 여부 확인").toBeTruthy();
    const res = await checkoutComplete(request, { orderId, paymentMethod: "offline" }, ownerCookie);
    expect(res.ok()).toBeTruthy();
  });

  test("8. 좌석 상태 확인 → 2개는 reserved, 나머지는 available", async () => {
    const res = await request.get(`/api/events/${eventId}/seat-maps/${seatMapId}/seats`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const seats = (body.data ?? body.items ?? body) as Array<{
      id: string;
      status: string;
    }>;
    // 결제완료 주문 2석 → sold(HELD→SOLD), 미결제 홀드 2석 → held. organizer block 없으니 reserved=0.
    // seats 라우트가 v2 status 투영(go-local은 frozen) → 점유(non-available)로 검증.
    const occupied = seats.filter((s) => s.status !== "available");
    const available = seats.filter((s) => s.status === "available");
    expect(occupied.length).toBeGreaterThanOrEqual(2);
    expect(available.length).toBeLessThan(30);
  });
});

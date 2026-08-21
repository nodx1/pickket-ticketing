/**
 * 토스페이먼츠 결제 플로우 (mock 모드) end-to-end.
 *
 * 검증 경로(감사: 토스 전환 Phase 1):
 *   checkout/initiate(pending) → /api/payment/toss/confirm(mock paymentKey)
 *     → 주문 completed + 참석자 confirmed + 티켓발급 + v2 write-through.
 *
 * mock 모드(TOSS_SECRET_KEY 미설정)에서는 실 PG 승인 없이 confirm 이 성공 처리된다
 * (paymentKey="mock_*"). 실 PG 승인 검증은 스테이징 실키로 별도.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";
import { checkoutInitiate } from "../helpers/checkout";

let request: APIRequestContext;
let eventId: string;
let productId: string;
let orderId: string;
let ownerCookie: string;
let totalAmount: number;

test.describe("토스페이먼츠 결제 플로우 (mock)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test("1. 유료 상품 생성", async () => {
    const res = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `토스 E2E 입장권 ${Date.now()}`,
        type: "ticket",
        price: "30000",
        stock: "100",
        minPerOrder: "1",
        maxPerOrder: "5",
        description: "토스 결제 E2E",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(res.status(), `상품 생성 실패: ${await res.text()}`).toBe(201);
    productId = (await res.json()).data.id;
    expect(productId).toBeTruthy();
  });

  test("2. 체크아웃 시작 (주문 pending)", async () => {
    test.setTimeout(60_000);
    const result = await checkoutInitiate(request, {
      eventId,
      buyerName: "토스 구매자",
      buyerEmail: "toss-buyer@test.kr",
      buyerPhone: "010-1234-5678",
      items: [{ productId, quantity: 2 }],
    });
    expect(result.response.status(), `체크아웃 시작 실패: ${await result.response.text()}`).toBe(201);
    orderId = result.orderId;
    ownerCookie = result.ownerCookie;
    totalAmount = result.totalAmount;
    expect(orderId).toBeTruthy();
    expect(totalAmount).toBe(60000); // 30000 × 2
  });

  test("3. 토스 confirm (mock) → 결제 승인", async () => {
    test.setTimeout(60_000);
    expect(orderId, "orderId 미설정").toBeTruthy();
    expect(ownerCookie, "ownerCookie 미설정").toBeTruthy();

    const res = await request.post(`/api/payment/toss/confirm`, {
      headers: { "Content-Type": "application/json", Cookie: `pickket_last_order=${ownerCookie}` },
      data: { paymentKey: `mock_${orderId}`, orderId, amount: totalAmount },
    });
    expect(res.status(), `토스 confirm 실패: ${await res.text()}`).toBe(200);
    const body = await res.json();
    // mock 모드는 pending(가상계좌)이 아니므로 즉시 승인.
    expect(body.data?.awaitingDeposit ?? false).toBe(false);
  });

  test("4. 주문 completed + 결제 paid", async () => {
    const res = await request.get(`/api/events/${eventId}/orders/${orderId}`);
    expect(res.status()).toBe(200);
    const order = (await res.json()).data;
    expect(order.status).toBe("completed");
    expect(order.paymentStatus).toBe("paid");
    expect(order.paymentMethod).toBe("toss");
  });

  test("5. 참석자 confirmed + 티켓번호(TKT-) 발급", async () => {
    const res = await request.get(`/api/events/${eventId}/attendees?search=toss-buyer@test.kr`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const attendees = body.data.items ?? body.data;
    const confirmed = attendees.find(
      (a: { status: string; ticketNumber: string }) => a.status === "confirmed" && a.ticketNumber,
    );
    expect(confirmed, "confirmed 참석자를 찾을 수 없습니다").toBeTruthy();
    expect(confirmed.ticketNumber).toMatch(/^TKT-/);
  });

  test("6. 소유권 쿠키 없이 confirm → 403 (임의주문 승인 차단)", async () => {
    // 별도 주문 생성 후 쿠키 없이 confirm 시도 → 403.
    const init = await checkoutInitiate(request, {
      eventId,
      buyerName: "무권한",
      buyerEmail: "noauth@test.kr",
      buyerPhone: "010-0000-0000",
      items: [{ productId, quantity: 1 }],
    });
    const otherOrderId = init.orderId;
    // 다른(불일치) 소유권 쿠키로 승인 시도 → 403.
    const res = await request.post(`/api/payment/toss/confirm`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: "pickket_last_order=deadbeef-dead-dead-dead-deaddeafbeef",
      },
      data: { paymentKey: `mock_${otherOrderId}`, orderId: otherOrderId, amount: 30000 },
    });
    expect(res.status()).toBe(403);
  });

  test("7. 금액 불일치 confirm → 400 (변조 차단)", async () => {
    const init = await checkoutInitiate(request, {
      eventId,
      buyerName: "금액변조",
      buyerEmail: "tamper@test.kr",
      buyerPhone: "010-0000-0001",
      items: [{ productId, quantity: 1 }],
    });
    const res = await request.post(`/api/payment/toss/confirm`, {
      headers: { "Content-Type": "application/json", Cookie: `pickket_last_order=${init.ownerCookie}` },
      data: { paymentKey: `mock_${init.orderId}`, orderId: init.orderId, amount: 1 }, // 실제 30000
    });
    expect(res.status()).toBe(400);
  });
});

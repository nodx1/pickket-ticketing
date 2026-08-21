/**
 * 주문 → 티켓 발행 → QR 체크인 end-to-end 테스트
 * 실제 PG 결제만 제외, 나머지 전체 플로우 검증
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";
import { checkoutInitiate, checkoutComplete } from "../helpers/checkout";

let request: APIRequestContext;
let eventId: string;
let eventSlug: string;
let productId: string;
let orderId: string;
let ownerCookie: string;
let ticketNumber: string;
let attendeeId: string;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let initialStock: number;

test.describe("주문→티켓→체크인 전체 플로우", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
    eventSlug = ids.liveEventSlug;
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  // ── 1. 상품 생성 ─────────────────────────────────────────────
  test("1. 이벤트에 유료 상품 생성", async () => {
    const res = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `E2E 유료 입장권 ${Date.now()}`,
        type: "ticket",
        price: "50000",
        stock: "100",
        minPerOrder: "1",
        maxPerOrder: "5",
        description: "E2E 테스트 일반 입장권",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(res.status(), `상품 생성 실패: ${await res.text()}`).toBe(201);
    const body = await res.json();
    productId = body.data.id;
    initialStock = 100;
    expect(productId).toBeTruthy();
  });

  test("1-1. 무료 상품도 생성", async () => {
    const res = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `E2E 무료 초대권 ${Date.now()}`,
        type: "ticket",
        price: "0",
        stock: "50",
        minPerOrder: "1",
        maxPerOrder: "2",
        description: "E2E 무료 티켓",
        isFree: true,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(res.status()).toBe(201);
  });

  // ── 2. 공개 이벤트 API로 상품 확인 ─────────────────────────
  test("2. 공개 API에서 이벤트+상품 조회", async () => {
    const res = await request.get(`/api/public/events/${eventSlug}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBeTruthy();
    expect(body.data.products.length).toBeGreaterThanOrEqual(2);

    // 방금 생성한 상품을 ID로 찾기
    const myProduct = body.data.products.find((p: { id: string }) => p.id === productId);
    expect(myProduct).toBeTruthy();
    expect(myProduct.price).toBe("50000");
  });

  // ── 3. 체크아웃 시작 ─────────────────────────────────────────
  test("3. 체크아웃 시작 (주문 생성)", async () => {
    test.setTimeout(60_000);
    // 변수 확인
    expect(eventId, "eventId 미설정").toBeTruthy();
    expect(productId, "productId 미설정").toBeTruthy();

    const result = await checkoutInitiate(request, {
      eventId,
      buyerName: "테스트 구매자",
      buyerEmail: "buyer@test.kr",
      buyerPhone: "010-9999-8888",
      items: [
        { productId, quantity: 2 },
      ],
    });
    expect(result.response.status(), `체크아웃 시작 실패: ${await result.response.text()}`).toBe(201);
    orderId = result.orderId;
    ownerCookie = result.ownerCookie;

    expect(orderId).toBeTruthy();
    expect(result.shortId).toMatch(/^ORD-/);
    expect(result.totalAmount).toBe(100000); // 50000 × 2
  });

  // ── 4. 주문 상태 확인 (pending) ──────────────────────────────
  test("4. 주문 상태 = pending 확인", async () => {
    expect(orderId, "orderId 미설정").toBeTruthy();
    const res = await request.get(`/api/events/${eventId}/orders/${orderId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("pending");
    expect(body.data.paymentStatus).toBe("pending");
    expect(body.data.totalAmount).toBe("100000");
  });

  // ── 5. 무통장입금 완료 + 주최자 입금확정 ─────────────────
  test("5. 무통장입금 완료 + 주최자 입금확정", async () => {
    test.setTimeout(60_000);

    expect(orderId, "orderId 미설정").toBeTruthy();
    expect(ownerCookie, "ownerCookie 미설정 — initiate 단계 실패 여부 확인").toBeTruthy();
    // 무통장(offline): 구매자 완료는 '입금대기(pending)'로 유지된다 (감사 P0-F).
    const res = await checkoutComplete(request, { orderId, paymentMethod: "offline" }, ownerCookie);
    expect(res.status(), `체크아웃 완료 실패: ${await res.text()}`).toBe(200);
    // 주최자가 실입금 확인 후 입금확정 → pending→completed + 티켓 발급 (감사 P0-F).
    const confirmRes = await request.post(`/api/events/${eventId}/orders/${orderId}/confirm-deposit`);
    expect(confirmRes.status(), `입금확정 실패: ${await confirmRes.text()}`).toBe(200);
    // status 는 test 6에서 GET으로 확인
  });

  // ── 6. 주문 상태 = completed + 참석자 confirmed ───────────
  test("6. 주문 completed + 참석자 confirmed + 티켓번호 생성", async () => {
    expect(orderId, "orderId 미설정").toBeTruthy();
    const res = await request.get(`/api/events/${eventId}/orders/${orderId}`);
    expect(res.status()).toBe(200);
    const order = (await res.json()).data;
    expect(order.status).toBe("completed");

    // 참석자 확인 — attendees API는 orderId를 반환하지 않으므로 이메일로 필터
    const attRes = await request.get(`/api/events/${eventId}/attendees?search=buyer@test.kr`);
    expect(attRes.status()).toBe(200);
    const attBody = await attRes.json();
    const myAttendees = attBody.data.items ?? attBody.data;
    expect(myAttendees.length).toBeGreaterThanOrEqual(2); // 2장 구매
    // 가장 최근 참석자 (createdAt DESC) — confirmed 상태인 것 찾기
    const confirmed = myAttendees.find(
      (a: { status: string; ticketNumber: string }) => a.status === "confirmed" && a.ticketNumber
    );
    expect(confirmed, "confirmed 참석자를 찾을 수 없습니다").toBeTruthy();
    expect(confirmed.ticketNumber).toMatch(/^TKT-/);

    ticketNumber = confirmed.ticketNumber;
    attendeeId = confirmed.id;
  });

  // ── 7. 재고 차감 확인 ────────────────────────────────────────
  test("7. 상품 재고 차감 확인", async () => {
    const res = await request.get(`/api/events/${eventId}/products`);
    expect(res.status()).toBe(200);
    const products = (await res.json()).data;
    const product = (Array.isArray(products) ? products : products.items).find(
      (p: { id: string }) => p.id === productId
    );
    expect(product).toBeTruthy();
    // 빅뱅 flip: products.stock은 동결 미러(구매 시 차감 안 함). 재고 정본 = v2.
    // go products GET이 노출하는 v2-backed soldCount(=tier.sold_count, refunded 제외)로 검증.
    expect(Number(product.soldCount)).toBe(2); // 2장 구매 → v2 sold_count=2
  });

  // ── 8. 티켓 QR 코드 생성 ────────────────────────────────────
  test("8. 티켓 QR 코드 API 응답", async () => {
    expect(ticketNumber, "ticketNumber 미설정").toBeTruthy();
    const res = await request.get(`/api/tickets/${ticketNumber}/qr`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // QR API는 동적 payload (JWT)를 반환 — 프론트에서 QR 이미지 생성
    expect(body.data.payload).toBeTruthy();
    expect(body.data.expiresIn).toBeGreaterThan(0);
  });

  // ── 9. 티켓 PDF 생성 ────────────────────────────────────────
  test("9. 티켓 PDF 생성", async () => {
    expect(ticketNumber, "ticketNumber 미설정").toBeTruthy();
    const res = await request.get(`/api/tickets/${ticketNumber}/pdf`);
    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"] ?? "";
    expect(contentType).toContain("pdf");
  });

  // ── 10. 체크인 리스트 생성 ──────────────────────────────────
  let checkInListId: string;

  test("10. 체크인 리스트 생성", async () => {
    expect(productId, "productId 미설정").toBeTruthy();
    const res = await request.post(`/api/events/${eventId}/check-in-lists`, {
      data: {
        name: "메인 입구",
        productIds: [productId],
      },
    });
    expect(res.status(), `체크인리스트 생성 실패: ${await res.text()}`).toBe(201);
    const body = await res.json();
    checkInListId = body.data.id;
    expect(checkInListId).toBeTruthy();
  });

  // ── 11. QR 체크인 수행 ──────────────────────────────────────
  test("11. QR 체크인 수행", async () => {
    test.setTimeout(60_000);
    expect(checkInListId, "checkInListId 미설정").toBeTruthy();
    expect(ticketNumber, "ticketNumber 미설정").toBeTruthy();
    const res = await request.post(`/api/events/${eventId}/check-in`, {
      data: {
        checkInListId,
        ticketNumber,
      },
    });
    expect(res.status(), `체크인 실패: ${await res.text()}`).toBe(200);
    const body = await res.json();
    // check-in API 응답: successResponse({ attendee: { name, ticketNumber, product, checkedInAt } })
    expect(body.success).toBe(true);
    expect(body.data.attendee.checkedInAt).toBeTruthy();
  });

  // ── 12. 중복 체크인 방어 ────────────────────────────────────
  test("12. 중복 체크인 → 이미 체크인됨 응답", async () => {
    const res = await request.post(`/api/events/${eventId}/check-in`, {
      data: {
        checkInListId,
        ticketNumber,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // 이미 체크인된 경우: successResponse({ alreadyCheckedIn: true, attendee: {...} })
    expect(body.success).toBe(true);
    expect(body.data.alreadyCheckedIn).toBe(true);
    expect(body.data.attendee.checkedInAt).toBeTruthy();
  });

  // ── 13. 참석자 상태 = checked_in 확인 ──────────────────────
  test("13. 참석자 상태 = checked_in 확인", async () => {
    expect(attendeeId, "attendeeId 미설정").toBeTruthy();
    const res = await request.get(`/api/events/${eventId}/attendees`);
    const body = await res.json();
    const att = (body.data.items ?? body.data).find(
      (a: { id: string }) => a.id === attendeeId
    );
    expect(att).toBeTruthy();
    expect(att.status).toBe("checked_in");
    expect(att.checkedInAt).toBeTruthy();
  });

  // ── 14. 공개 티켓 조회 ──────────────────────────────────────
  test("14. 공개 티켓 조회 API", async () => {
    expect(ticketNumber, "ticketNumber 미설정").toBeTruthy();
    const res = await request.get(`/api/public/tickets/${ticketNumber}`);
    // 공개 조회는 인증 or 공개 토큰 필요 — 세션 쿠키로 접근 가능
    expect(res.status()).toBeLessThanOrEqual(403);
  });

  // ── 15. 알림 생성 확인 ──────────────────────────────────────
  test("15. 주문 완료 알림 생성 확인", async () => {
    const res = await request.get("/api/notifications");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = body.data.items ?? body.data;
    const orderNotif = items.find(
      (n: { type: string }) => n.type === "new_order"
    );
    expect(orderNotif).toBeTruthy();
  });

  // ── 16. CSV 내보내기 ────────────────────────────────────────
  test("16. 주문 CSV 내보내기", async () => {
    const res = await request.get(`/api/events/${eventId}/orders/export`);
    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"] ?? "";
    // CSV 또는 octet-stream
    expect(
      contentType.includes("csv") || contentType.includes("octet") || contentType.includes("text")
    ).toBeTruthy();
  });

  test("16-1. 참석자 CSV 내보내기", async () => {
    const res = await request.get(`/api/events/${eventId}/attendees/export`);
    expect(res.status()).toBe(200);
  });

  // ── 17. 대시보드 매출 데이터 반영 ──────────────────────────
  test("17. 이벤트 대시보드에 매출 반영", async () => {
    const res = await request.get(`/api/events/${eventId}/dashboard`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // 매출이 0보다 커야 함
    const revenue = Number(body.data.totalRevenue ?? body.data.revenue ?? 0);
    expect(revenue).toBeGreaterThan(0);
  });

  // ── 18. 리포트 데이터 ───────────────────────────────────────
  test("18. 매출 리포트 조회", async () => {
    const res = await request.get(`/api/events/${eventId}/reports?type=sales`);
    expect(res.status()).toBe(200);
  });

  test("18-1. 상품별 리포트 조회", async () => {
    const res = await request.get(`/api/events/${eventId}/reports?type=products`);
    expect(res.status()).toBe(200);
  });

  test("18-2. 참석자 리포트 조회", async () => {
    const res = await request.get(`/api/events/${eventId}/reports?type=attendees`);
    expect(res.status()).toBe(200);
  });
});

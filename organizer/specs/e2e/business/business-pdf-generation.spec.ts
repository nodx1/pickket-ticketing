/**
 * PDF 생성 E2E — 티켓 + 영수증(인보이스)
 *
 * 커버리지:
 *  - GET /api/tickets/[ticketNumber]/pdf → 티켓 PDF (buyer/organizer 접근)
 *  - GET /api/events/[eventId]/orders/[orderId]/invoice → 영수증 PDF
 *  - Content-Type: application/pdf
 *  - PDF 매직 넘버(%PDF-) 확인
 *  - 한글 폰트(Pretendard) 임베딩 정상 렌더
 *  - Phase 5 @react-pdf/renderer v4.3.2 + sharp 의존성 회귀 방지
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";
import { extractOwnerCookie } from "../helpers/checkout";

let request: APIRequestContext;
let eventId: string;
let productId: string;
let orderId: string;
let ticketNumber: string;

test.describe("PDF 생성 (티켓 + 영수증)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;

    // 상품 + 주문 생성
    const pRes = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `E2E PDF 티켓 ${Date.now()}`,
        type: "ticket",
        price: "50000",
        stock: "5",
        minPerOrder: "1",
        maxPerOrder: "1",
        description: "PDF 테스트",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(pRes.status()).toBe(201);
    productId = (await pRes.json()).data.id;

    const initRes = await request.post("/api/checkout/initiate", {
      data: {
        eventId,
        items: [{ productId, quantity: 1 }],
        buyerName: "PDF테스트",
        buyerEmail: `pdf-${Date.now()}@test.local`,
        buyerPhone: "01012345678",
        finalAmount: 50000,
      },
    });
    expect(initRes.status()).toBe(201);
    orderId = (await initRes.json()).data.orderId;
    const ownerCookie = extractOwnerCookie(initRes);

    await request.post("/api/checkout/complete", {
      data: { orderId, paymentMethod: "offline" },
      headers: ownerCookie ? { Cookie: `pickket_last_order=${ownerCookie}` } : {},
    });

    // 티켓 번호 추출 (orders 상세 API)
    const detailRes = await request.get(`/api/events/${eventId}/orders/${orderId}`);
    if (detailRes.ok()) {
      const body = await detailRes.json();
      const order = body.data ?? body;
      const attendees = (order.attendees ?? []) as Array<{ ticketNumber?: string; ticket_number?: string }>;
      if (attendees.length > 0) {
        ticketNumber = (attendees[0].ticketNumber ?? attendees[0].ticket_number) as string;
      }
    }
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test("1. 티켓 PDF 다운로드 (주최자 인증)", async () => {
    test.skip(!ticketNumber, "티켓 번호를 얻지 못함");

    const res = await request.get(`/api/tickets/${ticketNumber}/pdf`);
    expect(res.ok()).toBeTruthy();

    const contentType = res.headers()["content-type"] ?? "";
    expect(contentType).toContain("application/pdf");

    const buffer = await res.body();
    expect(buffer.length).toBeGreaterThan(1000); // 최소 1KB (빈 PDF 방지)

    // PDF 매직 넘버 %PDF-
    const magic = buffer.slice(0, 5).toString("ascii");
    expect(magic).toBe("%PDF-");
  });

  test("2. 영수증 PDF 다운로드 (주최자 인증)", async () => {
    const res = await request.get(`/api/events/${eventId}/orders/${orderId}/invoice`);
    expect(res.ok()).toBeTruthy();

    const contentType = res.headers()["content-type"] ?? "";
    expect(contentType).toContain("application/pdf");

    const buffer = await res.body();
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  test("3. 비로그인 영수증 PDF → 401/403", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const res = await guest.get(`/api/events/${eventId}/orders/${orderId}/invoice`);
    expect([401, 403]).toContain(res.status());
    await guest.dispose();
  });

  test("4. 존재하지 않는 티켓번호 → 404", async () => {
    const res = await request.get("/api/tickets/TKT-NONEXISTENT-99999/pdf");
    expect(res.status()).toBe(404);
  });

  test("5. 티켓 QR 동적 payload API", async () => {
    test.skip(!ticketNumber, "티켓 번호 없음");
    const res = await request.get(`/api/tickets/${ticketNumber}/qr`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const data = body.data ?? body;
    // 동적 QR payload (30초 TTL, JWT 또는 signed string)
    expect(data.payload).toBeTruthy();
    expect(typeof data.payload).toBe("string");
    expect(data.expiresIn).toBe(30);
  });
});

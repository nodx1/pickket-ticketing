/**
 * 🚦 X1 골든패스 — cross-product 배포 차단기.
 *
 * 개설→상품→발행→게스트 구매→티켓→내티켓→환불 풀저니를 go API 로 구동하고,
 * 2026-06 완전체 실증이 박멸한 P0/HIGH 버그의 **회귀 가드**를 박는다. 깨지면 배포 중단.
 *
 * 가드 대상(실증 발견 버그):
 *  - P0 게스트 티켓조회 불능(order_items INNER JOIN) — my-tickets 가 발행티켓 반환해야
 *  - attendees 투영 회귀 — ticketNumber=TKT-, status=confirmed
 *  - promo discount_code_id 응답키 — 프로모 생성 201(502 아님)
 *  - sales_paused enforce — 일시중지 이벤트 구매 차단
 *  - 발행 status 매핑 — 이벤트 live 투영
 *  - 환불 라운드트립 — order refunded
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { extractOwnerCookie } from "../helpers/checkout";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3011";

let request: APIRequestContext;
let organizerId: string;
let eventId: string;
let productId: string;
let guestEmail: string;
let guestPhone: string;
let orderId: string;
let ticketNumber: string;

test.describe.serial("🚦 X1 골든패스 (cross-product 배포차단기)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: BASE });
    await loginAsDemoApi(request);
    const orgRes = await request.get("/api/organizers?limit=1");
    organizerId = (await orgRes.json()).data[0].id;
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test("1. 주최사: 이벤트 개설(live) → v2-백킹 + 발행 투영", async () => {
    const slug = `golden-${Date.now()}`;
    const res = await request.post("/api/events", {
      data: {
        organizers: [{ organizerId, role: "host", displayOrder: 0 }],
        title: "골든패스 이벤트",
        slug,
        startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        endsAt: new Date(Date.now() + 7 * 864e5 + 3 * 3600e3).toISOString(),
        eventType: "concert",
        ageRating: "all",
        isOnline: false,
        status: "live",
      },
    });
    expect(res.status(), `개설 실패 ${await res.text()}`).toBe(201);
    eventId = (await res.json()).data.id;

    // 발행 투영 가드: go status=live (v2 approved/bidding_open 투영)
    const detail = await (await request.get(`/api/events/${eventId}`)).json();
    expect(detail.data.status).toBe("live");
  });

  test("2. 주최사: 유료 상품 생성", async () => {
    const res = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: `골든상품 ${Date.now()}`,
        type: "ticket",
        price: "30000",
        stock: "100",
        minPerOrder: "1",
        maxPerOrder: "5",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(res.status(), `상품 실패 ${await res.text()}`).toBe(201);
    productId = (await res.json()).data.id;
  });

  test("3. [회귀가드] 프로모코드 생성 → 201 (discount_code_id 키)", async () => {
    // 실증 발견: v2 응답키 code_id→discount_code_id 불일치로 항상 502였음.
    const res = await request.post(`/api/events/${eventId}/promo-codes`, {
      data: { code: `GOLD${Date.now() % 100000}`, promoType: "percentage", discountValue: 10, usageLimit: 50 },
    });
    expect(res.status(), `프로모 502 회귀 ${await res.text()}`).toBe(201);
  });

  test("4. 소비자(게스트): 체크아웃 개시 → 결제완료", async () => {
    const guest = await playwrightGuest();
    guestEmail = `golden-guest-${Date.now()}@test.kr`;
    guestPhone = "01055556666";
    const init = await guest.post("/api/checkout/initiate", {
      data: {
        eventId,
        items: [{ productId, quantity: 1 }],
        buyerName: "골든게스트",
        buyerEmail: guestEmail,
        buyerPhone: guestPhone,
      },
    });
    expect(init.status(), `initiate 실패 ${await init.text()}`).toBe(201);
    orderId = (await init.json()).data.orderId;
    const ownerCookie = extractOwnerCookie(init);

    const complete = await guest.post("/api/checkout/complete", {
      data: { orderId, paymentMethod: "offline" },
      headers: ownerCookie ? { Cookie: `pickket_last_order=${ownerCookie}` } : {},
    });
    expect(complete.status()).toBe(200);
    expect((await complete.json()).data.status).toBe("completed");
    await guest.dispose();
  });

  test("5. [회귀가드] 참석자 투영 — ticketNumber=TKT-, status=confirmed", async () => {
    // 실증 발견: flip 후 attendees 가 v2 ticket_id(UUID)·v2 status('active')를 raw 노출했음.
    const res = await request.get(`/api/events/${eventId}/attendees?search=${encodeURIComponent(guestEmail)}`);
    expect(res.ok()).toBeTruthy();
    const items = (await res.json()).data.items ?? (await res.json()).data;
    const a = items.find((x: { ticketNumber: string; status: string }) => x.ticketNumber?.startsWith("TKT-"));
    expect(a, "TKT- 티켓번호 미발급(투영 회귀)").toBeTruthy();
    expect(a.status).toBe("confirmed");
    ticketNumber = a.ticketNumber;
  });

  test("6. [P0 회귀가드] 게스트 내티켓 조회 → 발행티켓 반환", async () => {
    // 실증 P0: my-tickets/tickets 가 폐기 order_items 를 INNER JOIN 해 v2-흐름 게스트 티켓 전탈락.
    const guest = await playwrightGuest();
    const mine = await guest.post("/api/public/my-tickets", { data: { email: guestEmail, phone: guestPhone } });
    const mineBody = await mine.text();
    expect(mine.status(), `my-tickets ${mine.status()} ${mineBody}`).toBe(200);
    const groups = JSON.parse(mineBody).data;
    // P0: order_items INNER JOIN 회귀 시 v2-흐름 게스트 티켓이 전탈락해 빈 배열이 됨.
    expect(Array.isArray(groups) && groups.length > 0, `게스트 티켓 조회 불능(P0 회귀) ${mineBody}`).toBeTruthy();
    // 발급 쿠키로 티켓 상세 접근
    const detail = await guest.get(`/api/public/tickets/${ticketNumber}`);
    expect(detail.status()).toBe(200);
    await guest.dispose();
  });

  test("7. [회귀가드] sales_paused — 일시중지 이벤트 구매 차단", async () => {
    // 실증 P0(v2): 일시중지 행사 결제 성공했었음. PATCH paused 후 구매 시도 → 차단되어야.
    const pause = await request.patch(`/api/events/${eventId}`, { data: { status: "paused" } });
    expect(pause.ok()).toBeTruthy();
    const guest = await playwrightGuest();
    const blocked = await guest.post("/api/checkout/initiate", {
      data: {
        eventId,
        items: [{ productId, quantity: 1 }],
        buyerName: "차단테스트",
        buyerEmail: `blocked-${Date.now()}@test.kr`,
        buyerPhone: "01099998888",
      },
    });
    expect(blocked.status(), "일시중지인데 구매 통과(sales_paused 회귀)").not.toBe(201);
    await guest.dispose();
    // 재개(후속 테스트 영향 방지)
    await request.patch(`/api/events/${eventId}`, { data: { status: "live" } });
  });

  test("8. 주최사: 전액 환불 → order refunded", async () => {
    const res = await request.patch(`/api/events/${eventId}/orders/${orderId}`, { data: { status: "refunded" } });
    expect(res.status(), `환불 실패 ${await res.text()}`).toBe(200);
  });
});

/** 게스트(비로그인) 컨텍스트 — 쿠키 격리. */
async function playwrightGuest(): Promise<APIRequestContext> {
  const { request: req } = await import("@playwright/test");
  return req.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
}

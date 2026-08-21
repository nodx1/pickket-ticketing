/**
 * fixture-event — 사이트맵 전수 e2e 용 "풀세팅 이벤트" 픽스처.
 *
 * 워크스페이스/구매자 페이지가 실데이터로 렌더되도록 한 이벤트에 상품·좌석맵·프로모·
 * 어필리에이트·완결주문·참석자·웹훅까지 채운다. 핵심(이벤트+유료상품)은 반드시 성공,
 * 나머지 enrichment 는 best-effort(실패해도 계속 — 페이지는 empty state 로 렌더됨).
 * BASE_URL 원격모드(globalSetup 스킵)에서 스펙 beforeAll 로 자체 구성.
 */
import type { APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "./auth";
import { checkoutInitiate, checkoutComplete } from "./checkout";

export interface FullEventFixture {
  eventId: string;
  slug: string;
  organizerId: string;
  productId: string;
  freeProductId: string | null;
  seatMapId: string | null;
  seatTierId: string | null;
  seatIds: string[];
  promoCode: string | null;
  affiliateCode: string | null;
  webhookId: string | null;
  orderId: string | null;
  attendeeId: string | null;
  buyerEmail: string;
}

export async function createFullEvent(request: APIRequestContext): Promise<FullEventFixture> {
  await loginAsDemoApi(request);
  const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  // organizer 확보(없으면 생성)
  const orgRes = await request.get("/api/organizers?limit=1");
  let organizerId: string | undefined = (await orgRes.json()).data?.[0]?.id;
  if (!organizerId) {
    const oc = await request.post("/api/organizers", {
      data: { name: `픽스처주최${sfx}`, slug: `fx-org-${sfx}` },
    });
    organizerId = (await oc.json()).data?.id;
  }
  if (!organizerId) throw new Error("fixture: organizer 확보 실패");

  // 라이브 v2-백킹 이벤트
  const slug = `fx-full-${sfx}`;
  const base = Date.now() + 30 * 24 * 3600 * 1000;
  const evRes = await request.post("/api/events", {
    data: {
      organizers: [{ organizerId, role: "host", displayOrder: 0 }],
      title: "E2E 풀세팅 이벤트",
      slug,
      summary: "sitemap 전수검사 픽스처",
      startsAt: new Date(base).toISOString(),
      endsAt: new Date(base + 3 * 3600 * 1000).toISOString(),
      venueName: "픽스처홀",
      eventType: "concert",
      ageRating: "all",
      isOnline: false,
      status: "live",
    },
  });
  const evBody = await evRes.json();
  const eventId: string | undefined = evBody.data?.id;
  if (!eventId) throw new Error(`fixture: 이벤트 생성 실패 ${JSON.stringify(evBody).slice(0, 200)}`);

  // 유료상품(필수)
  const pRes = await request.post(`/api/events/${eventId}/products`, {
    data: {
      name: "E2E 일반석",
      type: "ticket",
      price: "30000",
      isFree: false,
      unlimitedStock: true,
      minPerOrder: "1",
      maxPerOrder: "4",
      taxIncluded: true,
    },
  });
  const productId: string | undefined = (await pRes.json()).data?.id;
  if (!productId) throw new Error("fixture: 유료상품 생성 실패");

  const fx: FullEventFixture = {
    eventId,
    slug,
    organizerId,
    productId,
    freeProductId: null,
    seatMapId: null,
    seatTierId: null,
    seatIds: [],
    promoCode: null,
    affiliateCode: null,
    webhookId: null,
    orderId: null,
    attendeeId: null,
    buyerEmail: `fx-buyer-${sfx}@example.com`,
  };

  const tryStep = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      /* best-effort enrichment — 실패해도 계속 */
    }
  };

  // 무료상품
  await tryStep(async () => {
    const r = await request.post(`/api/events/${eventId}/products`, {
      data: { name: "E2E 무료초대", type: "ticket", price: "0", isFree: true, unlimitedStock: true, minPerOrder: "1", taxIncluded: true },
    });
    fx.freeProductId = (await r.json()).data?.id ?? null;
  });

  // 좌석 tier + 배치도(figmaLayout) → 좌석 v2 백필
  await tryStep(async () => {
    const t = await request.post(`/api/events/${eventId}/seat-tiers`, {
      data: { name: "VIP", capacity: 20, basePrice: 50000 },
    });
    const tierId: string | undefined = (await t.json()).data?.id;
    fx.seatTierId = tierId ?? null;
    if (!tierId) return;
    const m = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: "E2E 배치도",
        figmaLayout: { sections: [{ name: "VIP", x: 0, y: 0, kind: "assigned", rows: 2, seatsPerRow: 5, tierId }] },
      },
    });
    const mapId: string | undefined = (await m.json()).data?.id;
    fx.seatMapId = mapId ?? null;
    if (!mapId) return;
    const s = await request.get(`/api/events/${eventId}/seat-maps/${mapId}/seats`);
    const seats = (await s.json()).data ?? [];
    fx.seatIds = Array.isArray(seats) ? seats.map((x: { id: string }) => x.id) : [];
  });

  // 프로모코드
  await tryStep(async () => {
    const code = `PCT${sfx}`.toUpperCase().slice(0, 16);
    const r = await request.post(`/api/events/${eventId}/promo-codes`, {
      data: { code, promoType: "percentage", discountValue: 10, usageLimit: 100 },
    });
    if ((await r.json()).data?.id) fx.promoCode = code;
  });

  // 어필리에이트
  await tryStep(async () => {
    const code = `AFF${sfx}`.toUpperCase().slice(0, 16);
    const r = await request.post(`/api/events/${eventId}/affiliates`, {
      data: { name: "E2E 제휴", code, commissionRate: 10 },
    });
    if ((await r.json()).data?.id) fx.affiliateCode = code;
  });

  // 웹훅
  await tryStep(async () => {
    const r = await request.post(`/api/events/${eventId}/webhooks`, {
      data: { name: "E2E 웹훅", endpointUrl: "https://example.com/webhook", subscribedEvents: ["order.completed"] },
    });
    fx.webhookId = (await r.json()).data?.id ?? null;
  });

  // 완결 주문 → 참석자 (orders/attendees/tickets/reports/crm 페이지 실데이터)
  await tryStep(async () => {
    const init = await checkoutInitiate(request, {
      eventId,
      items: [{ productId, quantity: 1 }],
      buyerName: "픽스처구매자",
      buyerEmail: fx.buyerEmail,
      buyerPhone: "010-1234-5678",
    });
    if (!init.orderId) return;
    await checkoutComplete(request, { orderId: init.orderId, paymentMethod: "offline" }, init.ownerCookie);
    fx.orderId = init.orderId;
    const a = await request.get(`/api/events/${eventId}/attendees?search=${encodeURIComponent(fx.buyerEmail)}`);
    const aBody = await a.json();
    const items = aBody.data?.items ?? aBody.data ?? [];
    fx.attendeeId = Array.isArray(items) ? (items[0]?.id ?? null) : null;
  });

  return fx;
}

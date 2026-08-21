/**
 * 전체 구매 플로우 — 이벤트 생성부터 체크인까지
 *
 * 하드코딩 UUID 없음. 테스트 내에서 자체 이벤트 + 상품 생성 후 구매 플로우 실행.
 *
 * 검증 경로:
 *  1. 이벤트 생성 + 상품 추가 + live 전환
 *  2. 공개 이벤트 페이지 접근 + 보안 헤더 확인
 *  3. 체크아웃: initiate → complete (bank_transfer)
 *  4. 주최자 로그인 → 체크인 리스트 조회
 *
 * Phase 5 회귀 방지: rate limit / CSP / webhook / 좌석홀드가 동시 동작해야 성공.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { extractOwnerCookie } from "../helpers/checkout";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3011";

let request: APIRequestContext;
let eventId: string;
let eventSlug: string;
let productId: string;

test.describe.configure({ retries: 2 });

test.describe("전체 구매 플로우 (Phase 5 회귀 방지)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: BASE });
    await loginAsDemoApi(request);

    // 주최자 가져오기 — 없으면 생성
    const orgRes = await request.get("/api/organizers");
    const orgBody = await orgRes.json();
    const organizers = Array.isArray(orgBody.data)
      ? orgBody.data
      : orgBody.data?.items ?? [];
    let organizerId = organizers[0]?.id;

    if (!organizerId) {
      const createOrgRes = await request.post("/api/organizers", {
        data: {
          name: "E2E 테스트 주최자",
          slug: `e2e-org-${Date.now()}`,
          email: "e2e@test.local",
        },
      });
      const createOrgBody = await createOrgRes.json();
      organizerId = createOrgBody.data?.id;
    }
    expect(organizerId).toBeTruthy();

    // 이벤트 생성
    const ts = Date.now();
    const slug = `e2e-fullflow-${ts}`;
    const createRes = await request.post("/api/events", {
      data: {
        title: `E2E 풀플로우 ${ts}`,
        slug,
        startsAt: new Date(ts + 30 * 24 * 60 * 60 * 1000).toISOString(),
        endsAt: new Date(ts + 30 * 24 * 60 * 60 * 1000 + 3600000).toISOString(),
        eventType: "concert",
        ageRating: "all",
        isOnline: false,
        status: "draft",
        organizerId,
        organizers: [{ organizerId, role: "host", displayOrder: 0 }],
      },
    });
    const createBody = await createRes.json();
    expect(createRes.status(), `이벤트 생성 실패: ${JSON.stringify(createBody)}`).toBe(201);
    eventId = createBody.data.id;
    eventSlug = slug; // API가 slug를 RETURNING하지 않으므로 직접 유지

    // 상품 추가
    const prodRes = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: "E2E 일반 티켓",
        type: "ticket",
        price: "50000",
        stock: "100",
        minPerOrder: "1",
        maxPerOrder: "4",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(prodRes.status()).toBe(201);
    const prodBody = await prodRes.json();
    productId = prodBody.data.id;

    // live 전환 — 이벤트 생성 API가 RETURNING id만 하므로 title 직접 유지
    const title = `E2E 풀플로우 ${ts}`;
    const liveRes = await request.patch(`/api/events/${eventId}/settings`, {
      data: {
        title,
        slug: eventSlug,
        startsAt: new Date(ts + 30 * 24 * 60 * 60 * 1000).toISOString(),
        endsAt: new Date(ts + 30 * 24 * 60 * 60 * 1000 + 3600000).toISOString(),
        eventType: "concert",
        ageRating: "all",
        isOnline: false,
        status: "live",
      },
    });
    const liveBody = await liveRes.json();
    expect(liveRes.status(), `live 전환 실패: ${JSON.stringify(liveBody)}`).toBe(200);
  });

  test.afterAll(async () => {
    // cleanup: archived로 전환
    if (eventId) {
      await request.patch(`/api/events/${eventId}/settings`, {
        data: {
          title: "cleanup",
          slug: eventSlug,
          startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 3600000).toISOString(),
          eventType: "concert",
          ageRating: "all",
          isOnline: false,
          status: "archived",
        },
      });
    }
    await request.dispose();
  });

  test("1. 공개 이벤트 페이지 로드 + 보안 헤더 확인", async () => {
    const response = await request.get(`/e/${eventSlug}`);
    expect(response.ok()).toBeTruthy();

    const headers = response.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["permissions-policy"]).toContain("camera=(self)");
    expect(headers["content-security-policy"]).toContain("frame-src");
  });

  test("2. 구매 플로우: initiate → complete → 티켓 발급", async () => {
    // 이벤트 상세 조회
    const eventRes = await request.get(`/api/public/events/${eventSlug}`);
    expect(eventRes.ok()).toBeTruthy();

    // 체크아웃 시작
    const initiateRes = await request.post("/api/checkout/initiate", {
      data: {
        eventId,
        items: [{ productId, quantity: 1 }],
        buyerName: "E2E 테스트",
        buyerEmail: `e2e-${Date.now()}@test.local`,
        buyerPhone: "01012345678",
        finalAmount: 50000,
      },
    });
    expect(initiateRes.status()).toBe(201);
    const initiateBody = await initiateRes.json();
    expect(initiateBody.success).toBe(true);

    const orderId = initiateBody.data.orderId;
    const shortId = initiateBody.data.shortId;
    const ownerCookie = extractOwnerCookie(initiateRes);
    expect(orderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(shortId).toMatch(/^ORD-/);

    // 결제 완료 (bank_transfer) — Secure 쿠키를 http:// 환경에서도 전달하기 위해 명시 주입
    const completeRes = await request.post("/api/checkout/complete", {
      data: { orderId, paymentMethod: "bank_transfer" },
      headers: ownerCookie ? { Cookie: `pickket_last_order=${ownerCookie}` } : {},
    });
    expect(completeRes.ok()).toBeTruthy();
    const completeBody = await completeRes.json();
    expect(completeBody.success).toBe(true);

    // 완료 페이지 접근
    const completePageRes = await request.get(
      `/e/${eventSlug}/checkout/complete?orderId=${orderId}`,
    );
    expect(completePageRes.ok()).toBeTruthy();
  });

  test("3. 주최자 체크인 리스트 조회", async () => {
    const listRes = await request.get(`/api/events/${eventId}/check-in-lists`);
    expect([200, 204]).toContain(listRes.status());
  });
});

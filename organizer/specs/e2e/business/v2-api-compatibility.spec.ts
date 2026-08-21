import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";

/**
 * v2 Consumer가 go의 공개 API를 소비할 때 기대하는 응답 포맷을 검증합니다.
 * 이 테스트가 깨지면 v2 Consumer도 함께 깨지므로, 응답 스키마 변경 시 반드시 이 테스트를 확인하세요.
 */

test.describe("v2 공개 API 호환성", () => {
  test("1. GET /api/public/events → 이벤트 목록 응답 포맷", async ({ request }) => {
    const res = await request.get("/api/public/events");
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: {
        events: Array<{
          id: string;
          title: string;
          slug: string;
          startsAt: string;
          endsAt: string;
          status: string;
          venueName?: string;
          heroImageUrl?: string;
          organizerName?: string;
        }>;
        total: number;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(typeof body.data.total).toBe("number");
    expect(Array.isArray(body.data.events)).toBe(true);

    // 이벤트가 있으면 필드 검증
    if (body.data.events.length > 0) {
      const event = body.data.events[0];
      expect(event.id).toBeTruthy();
      expect(event.title).toBeTruthy();
      expect(event.slug).toBeTruthy();
      expect(event.startsAt).toBeTruthy();
      expect(event.status).toBe("live"); // 공개 API는 live만 반환
    }
  });

  test("2. GET /api/public/events/[slug] → 이벤트 상세 응답 포맷", async ({ request }) => {
    // 먼저 목록에서 slug 가져오기
    const listRes = await request.get("/api/public/events");
    const listBody = (await listRes.json()) as {
      data: { events: Array<{ slug: string }> };
    };

    if (!listBody.data?.events?.length) {
      test.skip(true, "공개 이벤트가 없어 건너뜁니다");
      return;
    }

    const slug = listBody.data.events[0].slug;
    const res = await request.get(`/api/public/events/${slug}`);
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: {
        id: string;
        title: string;
        slug: string;
        description?: string;
        startsAt: string;
        endsAt: string;
        venueName?: string;
        venueAddress?: string;
        organizerName?: string;
        products?: Array<{
          id: string;
          name: string;
          price: number;
          stock: number | null;
        }>;
      };
    };

    expect(body.success).toBe(true);
    const event = body.data;
    expect(event.id).toBeTruthy();
    expect(event.title).toBeTruthy();
    expect(event.slug).toBe(slug);
    expect(event.startsAt).toBeTruthy();
    expect(event.endsAt).toBeTruthy();
  });

  test("3. POST /api/checkout/initiate → 스키마 검증 (빈 body → 400)", async ({ request }) => {
    const res = await request.post("/api/checkout/initiate", {
      data: {},
    });
    // 빈 body → 400 Zod validation error (5xx가 아니어야 함)
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test("4. POST /api/checkout/initiate → promoCode optional 필드 수락", async ({ request }) => {
    const res = await request.post("/api/checkout/initiate", {
      data: {
        eventId: "00000000-0000-0000-0000-000000000000",
        items: [{ productId: "00000000-0000-0000-0000-000000000001", quantity: 1 }],
        buyerName: "테스트",
        buyerEmail: "test@test.com",
        buyerPhone: "010-0000-0000",
        finalAmount: 10000,
        promoCode: "TESTCODE",
        answers: {},
      },
    });
    // 이벤트가 존재하지 않으므로 404 또는 400 기대 (500이 아니면 OK)
    expect(res.status()).toBeLessThan(500);
  });

  test("5. GET /api/health → 헬스체크", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { status: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ok");
  });

  test("6. 보안 헤더 존재", async ({ request }) => {
    const res = await request.get("/api/health");
    const headers = res.headers();
    // CSP 또는 X-Frame-Options 중 하나 이상 존재
    const hasSecurityHeaders =
      headers["content-security-policy"] ||
      headers["x-frame-options"] ||
      headers["strict-transport-security"];
    expect(hasSecurityHeaders).toBeTruthy();
  });

  test("7. GET /api/public/events?format=v2 → v2 포맷 호환", async ({ request }) => {
    const res = await request.get("/api/public/events?format=v2");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  test("8. 비인증 상태에서 관리 API 차단", async ({ request }) => {
    const endpoints = [
      "/api/events",
      "/api/dashboard",
      "/api/account",
      "/api/notifications",
    ];

    for (const endpoint of endpoints) {
      const res = await request.get(endpoint);
      expect(res.status(), `${endpoint} should be 401`).toBe(401);
    }
  });

  test("9. 인증 후 관리 API 접근", async ({ request }) => {
    await loginAsDemoApi(request);
    const res = await request.get("/api/events");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});

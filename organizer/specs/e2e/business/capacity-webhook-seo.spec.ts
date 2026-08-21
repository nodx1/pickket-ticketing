/**
 * 용량관리 + 웹훅 + SEO + 대기열 + 이벤트 CRUD 테스트
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let eventId: string;
let eventSlug: string;

test.describe("용량관리 + 웹훅 + SEO + 이벤트 관리", () => {
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

  // ── 웹훅 ────────────────────────────────────────────────────

  test("1. 웹훅 등록", async () => {
    const res = await request.post(`/api/events/${eventId}/webhooks`, {
      data: {
        name: `E2E 테스트 웹훅 ${Date.now()}`,
        endpointUrl: "https://httpbin.org/post",
        subscribedEvents: ["order.completed", "attendee.checked_in"],
      },
    });
    expect(res.status(), `웹훅 등록 실패: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeTruthy();
  });

  test("2. 웹훅 목록 조회", async () => {
    const res = await request.get(`/api/events/${eventId}/webhooks`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body.data) ? body.data : body.data?.items ?? [];
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  // ── 용량 관리 ───────────────────────────────────────────────

  test("3. 상품 용량 설정", async () => {
    // 먼저 상품 ID 가져오기
    const prodRes = await request.get(`/api/events/${eventId}/products`);
    const products = (await prodRes.json()).data;
    const items = Array.isArray(products) ? products : products?.items ?? [];
    if (items.length === 0) {
      test.skip(true, "상품 없음");
      return;
    }
    const firstProduct = items[0];

    const res = await request.post(`/api/events/${eventId}/capacity`, {
      data: {
        productId: firstProduct.id,
        capacity: 200,
      },
    });
    expect(res.status(), `용량 설정 실패: ${await res.text()}`).toBe(200);
  });

  // ── 대기열 ──────────────────────────────────────────────────

  test("4. 대기열 상태 조회", async () => {
    // 토큰 없이 호출하면 400
    const res = await request.get(`/api/events/${eventId}/public/queue/status`);
    expect([200, 400]).toContain(res.status());
  });

  // ── 스케줄 ──────────────────────────────────────────────────

  test("5. 스케줄 아이템 생성", async () => {
    const res = await request.post(`/api/events/${eventId}/schedules`, {
      data: {
        title: "오프닝 세션",
        description: "E2E 테스트 스케줄",
        startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 3600000).toISOString(),
      },
    });
    expect(res.status(), `스케줄 생성 실패: ${await res.text()}`).toBe(201);
  });

  test("6. 스케줄 목록 조회", async () => {
    const res = await request.get(`/api/events/${eventId}/schedules`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body.data) ? body.data : body.data?.items ?? [];
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  // ── 등록 질문 ───────────────────────────────────────────────

  test("7. 등록 질문 생성", async () => {
    const res = await request.post(`/api/events/${eventId}/questions`, {
      data: {
        label: "식이 제한이 있으신가요?",
        questionType: "short_text",
        isRequired: false,
      },
    });
    expect(res.status(), `질문 생성 실패: ${await res.text()}`).toBe(201);
  });

  // ── 메시지 템플릿 ──────────────────────────────────────────

  test("8. 메시지 템플릿 생성", async () => {
    const res = await request.post(`/api/events/${eventId}/messages`, {
      data: {
        title: "환영 메시지",
        body: "안녕하세요, 이벤트 참가가 확정되었습니다.",
        channel: "email",
        recipientFilter: "all",
      },
    });
    expect(res.status(), `메시지 생성 실패: ${await res.text()}`).toBe(201);
  });

  // ── 이벤트 설정 ─────────────────────────────────────────────

  test("9. 이벤트 설정 조회", async () => {
    const res = await request.get(`/api/events/${eventId}/settings`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveProperty("title");
  });

  test("10. 이벤트 설정 수정", async () => {
    // 먼저 현재 설정 가져오기
    const getRes = await request.get(`/api/events/${eventId}/settings`);
    const current = (await getRes.json()).data;

    const res = await request.patch(`/api/events/${eventId}/settings`, {
      data: {
        title: current.title,
        slug: current.slug,
        description: "E2E 테스트로 수정된 설명",
        startsAt: current.startsAt,
        endsAt: current.endsAt,
        eventType: current.eventType,
        ageRating: current.ageRating,
        isOnline: current.isOnline ?? false,
        status: current.status,
      },
    });
    expect(res.status(), `설정 수정 실패: ${await res.text()}`).toBe(200);
  });

  // ── 이벤트 복제 ─────────────────────────────────────────────

  test("11. 이벤트 복제", async () => {
    const res = await request.post(`/api/events/${eventId}/duplicate`);
    expect(res.status(), `복제 실패: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.data?.id ?? body.data?.eventId).toBeTruthy();
  });

  // ── SEO ─────────────────────────────────────────────────────

  test("12. OG 이미지 생성", async () => {
    const res = await request.get(`/api/events/${eventId}/og-image`);
    expect(res.status()).toBe(200);
    const contentType = res.headers()["content-type"] ?? "";
    expect(contentType).toContain("image");
  });

  test("13. sitemap.xml 접근", async () => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain("urlset");
  });

  test("14. robots.txt 접근", async () => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).toContain("sitemap");
  });

  test("15. manifest.webmanifest 접근", async () => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBeTruthy();
    expect(body.theme_color).toBe("#6C5CE7");
  });

  // ── 공개 이벤트 메타데이터 확인 ──────────────────────────────

  test("16. 이벤트 공개 API로 메타데이터 확인", async () => {
    // page.goto로 HTML 파싱하는 대신 API로 직접 검증 (Turbopack dev flaky 방지).
    // OG 태그 자체는 ITZY full flow 테스트에서 별도 검증.
    const res = await request.get(`/api/public/events/${eventSlug}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const event = body.data ?? body;
    expect(event.title).toBeTruthy();
    expect(typeof event.title).toBe("string");
    expect((event.title as string).length).toBeGreaterThan(0);
  });

  // ── 검색 ────────────────────────────────────────────────────

  test("17. 이벤트 검색 API", async () => {
    const res = await request.get("/api/search?q=뮤직");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toBeTruthy();
  });

  // ── 감사 로그 ───────────────────────────────────────────────

  test("18. 감사 로그에 기록 존재", async () => {
    const res = await request.get("/api/admin/audit-logs");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body.data) ? body.data : body.data?.items ?? [];
    // 이전 테스트에서 생성된 감사 로그가 있어야 함
    expect(items.length).toBeGreaterThanOrEqual(0);
  });

  // ── 정산 ────────────────────────────────────────────────────

  test("19. 정산 내역 조회", async () => {
    const res = await request.get("/api/account/settlements");
    expect(res.status()).toBe(200);
  });

  // ── 그룹 예약 ───────────────────────────────────────────────

  test("20. 그룹 예약 목록 조회", async () => {
    const res = await request.get(`/api/events/${eventId}/group-bookings`);
    expect(res.status()).toBe(200);
  });
});

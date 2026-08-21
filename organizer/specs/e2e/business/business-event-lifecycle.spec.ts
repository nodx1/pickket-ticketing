/**
 * 이벤트 생성/발행 전체 라이프사이클 E2E
 *
 * 주최자 온보딩 시나리오:
 *  1. 이벤트 생성 (POST /api/events)
 *  2. 상품 추가 (POST /api/events/:id/products)
 *  3. 설정 수정 (PATCH /api/events/:id/settings)
 *  4. 발행 체크 (GET /api/events/:id/publish-check)
 *  5. 상태를 live로 전환 (PATCH /api/events/:id → status:live)
 *  6. 공개 페이지에서 조회 가능 확인
 *  7. 복제 (POST /api/events/:id/duplicate)
 *  8. 아카이브 (status:archived)
 */
import crypto from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import "../helpers/v2"; // 사이드이펙트: .env.local 로딩 → runner process.env 에 GO_WEBHOOK_SECRET 주입

let request: APIRequestContext;
let eventId: string;
let slug: string;
let duplicatedEventId: string;
let organizerId: string;

const WEBHOOK_SECRET =
  process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET ?? "";

/** v2 admin → go 심사결과 webhook 시뮬 (HMAC: sha256(secret, `${ts}.${rawBody}`)). 발행=admin 승인 경로. */
async function simulateReviewApproval(id: string) {
  const rawBody = JSON.stringify({
    action: "approved",
    reviewerId: "e2e-admin",
    reviewedAt: new Date().toISOString(),
  });
  const timestamp = new Date().toISOString();
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return request.post(`/api/v2-webhook/events/${id}/review-result`, {
    data: rawBody,
    headers: {
      "content-type": "application/json",
      "x-pickket-signature": signature,
      "x-pickket-timestamp": timestamp,
      "x-pickket-event": "event.review.completed",
      "x-pickket-delivery-id": crypto.randomUUID(),
    },
  });
}

test.describe("이벤트 라이프사이클 — 생성부터 아카이브까지", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await loginAsDemoApi(request);

    // host organizer 조회 (이벤트 생성에 필수)
    const orgRes = await request.get("/api/organizers");
    const orgBody = await orgRes.json();
    const organizers = (orgBody.data?.items ?? orgBody.data ?? []) as Array<{ id: string }>;
    expect(organizers.length).toBeGreaterThan(0);
    organizerId = organizers[0].id;
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test("1. 이벤트 생성 (POST /api/events)", async () => {
    slug = `e2e-lifecycle-${Date.now()}`;
    const res = await request.post("/api/events", {
      data: {
        organizers: [
          { organizerId, role: "host", displayOrder: 0 },
        ],
        title: "E2E 라이프사이클 테스트 이벤트",
        slug,
        summary: "자동 생성된 테스트 이벤트",
        description: "Phase 5 회귀 방지용",
        startsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000 + 3 * 3600 * 1000).toISOString(),
        venueName: "E2E 테스트홀",
        venueAddress: "서울시 E2E로 123",
        eventType: "concert",
        ageRating: "all",
        isOnline: false,
        status: "draft",
      },
    });
    expect(res.status(), `create 실패 ${await res.text()}`).toBe(201);
    const body = await res.json();
    eventId = body.data.id;
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("2. 상품 추가 (ticket)", async () => {
    const res = await request.post(`/api/events/${eventId}/products`, {
      data: {
        name: "일반석",
        type: "ticket",
        price: "30000",
        stock: "100",
        minPerOrder: "1",
        maxPerOrder: "4",
        description: "일반 입장권",
        isFree: false,
        unlimitedStock: false,
        taxIncluded: true,
      },
    });
    expect(res.status()).toBe(201);
  });

  test("3. 이벤트 설정 수정 (Phase 5 event_type 확장 회귀 검증)", async () => {
    const res = await request.patch(`/api/events/${eventId}/settings`, {
      data: {
        title: "수정된 제목",
        slug,
        description: "수정됨",
        startsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        endsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000 + 3 * 3600 * 1000).toISOString(),
        eventType: "musical", // Phase 5 신규 확장 enum
        ageRating: "all",
        isOnline: false,
        status: "draft",
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test("4. 발행 체크 (publish-check)", async () => {
    const res = await request.get(`/api/events/${eventId}/publish-check`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const checks = (body.data?.checks ?? body.data ?? []) as Array<{
      status: string;
      label: string;
    }>;
    expect(Array.isArray(checks)).toBeTruthy();
    expect(checks.length).toBeGreaterThan(0);
  });

  test("5. 발행 — draft→pending_review 후 v2 승인 webhook으로 live", async () => {
    // (1) 주최자: draft → pending_review (심사 요청). live 직접 전환은 admin 전용이라 불가.
    const submit = await request.patch(`/api/events/${eventId}`, {
      data: { status: "pending_review" },
    });
    expect(submit.ok(), `심사 요청 실패 ${await submit.text()}`).toBeTruthy();
    // (2) v2 admin 승인 결과 webhook 시뮬 → pending_review → live (admin 액터)
    const approve = await simulateReviewApproval(eventId);
    expect(approve.ok(), `승인 webhook 실패 ${await approve.text()}`).toBeTruthy();
    expect((await approve.json()).status).toBe("live");
  });

  test("6. 공개 페이지에서 조회 가능 (게스트)", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const res = await guest.get(`/api/public/events/${slug}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const event = body.data ?? body;
    expect(event.title).toBeTruthy();
    expect(event.products?.length ?? 0).toBeGreaterThan(0);
    await guest.dispose();
  });

  test("7. 이벤트 복제", async () => {
    const res = await request.post(`/api/events/${eventId}/duplicate`);
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    duplicatedEventId = body.data?.id ?? body.id;
    expect(duplicatedEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(duplicatedEventId).not.toBe(eventId);
  });

  test("8. 복제된 이벤트의 상품도 복제됨", async () => {
    if (!duplicatedEventId) {
      test.skip(true, "복제 실패");
      return;
    }
    const res = await request.get(`/api/events/${duplicatedEventId}/products`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const products = (body.data?.items ?? body.data ?? []) as Array<unknown>;
    expect(products.length).toBeGreaterThan(0);
  });

  test("9. 원본 이벤트를 archived로 전환", async () => {
    const res = await request.patch(`/api/events/${eventId}`, {
      data: { status: "archived" },
    });
    expect(res.ok()).toBeTruthy();
  });

  test("10. archived 이벤트는 공개 API에서 접근 불가", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const res = await guest.get(`/api/public/events/${slug}`);
    // archived는 404 또는 live 필터로 404
    expect([404, 403]).toContain(res.status());
    await guest.dispose();
  });

  test("11. archived 이벤트 영구삭제 — 제거된 AI 테이블을 조회하지 않음", async () => {
    const res = await request.delete(`/api/events/${eventId}/purge`);
    expect(res.status(), `purge 실패 ${await res.text()}`).toBe(200);
    expect((await res.json()).data?.deleted).toBe(true);
  });

  test("12. 복제본 cleanup (archived)", async () => {
    if (!duplicatedEventId) return;
    await request.patch(`/api/events/${duplicatedEventId}`, {
      data: { status: "archived" },
    });
  });
});

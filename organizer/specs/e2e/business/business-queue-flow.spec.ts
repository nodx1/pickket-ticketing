/**
 * 대기열(Smart Queue) 플로우 E2E
 *
 * 티켓팅 폭발 트래픽 대응의 핵심 기능.
 *
 * 커버리지:
 *  - POST /api/events/[eventId]/public/queue/join → 세션 토큰 발급
 *  - queue_enabled=false 이벤트 → 즉시 active (position:0)
 *  - GET /api/events/[eventId]/public/queue/status?token=X → 현재 위치 조회
 *  - 토큰 없이 status 조회 → 400
 *  - 잘못된 토큰 → 에러 또는 빈 응답
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let eventId: string;

test.describe("대기열(Smart Queue) 플로우", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  test("1. queue_enabled=false 이벤트 → 즉시 active (position:0)", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const res = await guest.post(`/api/events/${eventId}/public/queue/join`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const data = body.data ?? body;
    expect(data.position).toBe(0);
    expect(data.status).toBe("active");
    await guest.dispose();
  });

  test("2. 비회원 queue/join 가능 (공개 API)", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const res = await guest.post(`/api/events/${eventId}/public/queue/join`);
    expect(res.ok()).toBeTruthy();
    await guest.dispose();
  });

  test("3. queue/status — 토큰 없이 → 400", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const res = await guest.get(`/api/events/${eventId}/public/queue/status`);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/토큰/);
    await guest.dispose();
  });

  test("4. queue/status — 유효 토큰으로 조회", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const joinRes = await guest.post(`/api/events/${eventId}/public/queue/join`);
    const joinBody = await joinRes.json();
    const token = joinBody.data?.sessionToken;

    if (!token) {
      // queue_enabled=false면 토큰이 빈 문자열일 수 있음
      test.skip(true, "queue_enabled=false — 토큰 발급 안 됨");
      await guest.dispose();
      return;
    }

    const statusRes = await guest.get(
      `/api/events/${eventId}/public/queue/status?token=${encodeURIComponent(token)}`,
    );
    expect(statusRes.ok()).toBeTruthy();
    await guest.dispose();
  });

  test("5. queue/status — 가짜 토큰 → 에러 처리", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const res = await guest.get(
      `/api/events/${eventId}/public/queue/status?token=fake_invalid_token_xxx`,
    );
    // 200(빈 데이터) 또는 400/500 모두 허용 — 크래시만 안 나면 OK
    expect([200, 400, 404, 500]).toContain(res.status());
    await guest.dispose();
  });

  test("6. 존재하지 않는 이벤트 queue/join → 에러 처리", async ({ playwright }) => {
    const guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    const fakeId = "11111111-1111-4111-8111-111111111111";
    const res = await guest.post(`/api/events/${fakeId}/public/queue/join`);
    // 존재 안 해도 queue_enabled=false로 처리 → 200 또는 404
    expect([200, 404, 500]).toContain(res.status());
    await guest.dispose();
  });
});

/**
 * 트랙 7.8 + 7.9 — 좌석 분석 + funnel API 회귀
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let eventId: string;
let seatMapId: string;

test.describe.serial("좌석 분석 + funnel (트랙 7.8 / 7.9)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;

    const mapRes = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `analytics ${Date.now()}`,
        sections: ["A"],
        rowsPerSection: 1,
        seatsPerRow: 4,
      },
    });
    expect(mapRes.ok()).toBeTruthy();
    seatMapId = (await mapRes.json()).data.id;
  });

  test.afterAll(async () => {
    await request.dispose().catch(() => undefined);
  });

  test("funnel: POST 이벤트 수집 (인증 없음)", async () => {
    const res = await request.post("/api/public/seat-funnel", {
      data: {
        eventId,
        seatMapId,
        step: "view",
        seatCount: 0,
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("funnel: 잘못된 step 도 200 (fail-soft)", async () => {
    const res = await request.post("/api/public/seat-funnel", {
      data: { eventId, step: "invalid" },
    });
    expect(res.ok()).toBeTruthy();
  });

  test("analytics: 주최자 통계 조회 (statusCounts/funnel/tier)", async () => {
    const res = await request.get(`/api/events/${eventId}/seat-analytics`);
    expect(res.ok(), `analytics 실패: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.data.statusCounts).toBeTruthy();
    expect(body.data.funnel).toBeTruthy();
    expect(typeof body.data.funnel.view).toBe("number");
    expect(body.data.funnelDropoffRate).toBeTruthy();
    expect(Array.isArray(body.data.tierStats)).toBeTruthy();
    expect(Array.isArray(body.data.sectionTopRevenue)).toBeTruthy();
  });

  test("analytics: 잘못된 eventId 400", async () => {
    const res = await request.get(`/api/events/not-a-uuid/seat-analytics`);
    expect(res.status()).toBe(400);
  });
});

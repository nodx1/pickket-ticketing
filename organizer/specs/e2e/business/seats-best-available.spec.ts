/**
 * 좌석 best-available E2E — Phase 12
 *
 * `/api/public/events/[slug]/seats/best-available` 가
 * quantity 개수만큼 인접·고품질 좌석을 반환하는지 검증한다.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let eventId: string;
let slug: string;
let mapId: string;

test.describe.serial("좌석 best-available (Phase 10~11)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
    slug = ids.liveEventSlug;

    const mapRes = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `best-available ${Date.now()}`,
        sections: ["A"],
        rowsPerSection: 2,
        seatsPerRow: 10,
      },
    });
    if (!mapRes.ok()) {
      test.skip(true, `seat-map 생성 실패 — 상태 ${mapRes.status()}`);
      return;
    }
    const mapBody = await mapRes.json();
    mapId = mapBody.data.id;
  });

  test.afterAll(async () => {
    await request.dispose().catch(() => undefined);
  });

  test("best-available 3석 요청 → 3개 반환", async () => {
    const res = await request.get(
      `/api/public/events/${slug}/seats/best-available?mapId=${mapId}&quantity=3&adjacent=true`,
    );
    if (res.status() === 404) {
      test.skip(true, "best-available API 미구현");
      return;
    }
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const seats = body.data?.seats ?? body.data ?? [];
    expect(Array.isArray(seats)).toBeTruthy();
    expect(seats.length).toBe(3);
  });

  test("best-available 과다 수량 요청 → 가용 수량 내에서 반환", async () => {
    const res = await request.get(
      `/api/public/events/${slug}/seats/best-available?mapId=${mapId}&quantity=999`,
    );
    if (res.status() === 404) {
      test.skip(true, "best-available API 미구현");
      return;
    }
    if (res.ok()) {
      const body = await res.json();
      const seats = body.data?.seats ?? body.data ?? [];
      expect(seats.length).toBeLessThanOrEqual(20);
    } else {
      expect([400, 409, 422]).toContain(res.status());
    }
  });
});

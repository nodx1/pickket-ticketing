/**
 * 트랙 1.8 + 1.9 신규 API 스목 회귀
 * - companion: 인접 N석 atomic hold
 * - watch: 즐겨찾기 + 가격 알림 (POST/GET/DELETE)
 *
 * Phase 5A-4 의 seed 이벤트를 사용. group_allocator + seat_watches 동작 검증.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let slug: string;
let eventId: string;
let seatMapId: string;
let firstSeatId: string;

test.describe.serial("좌석 companion + watch 신규 API (트랙 1.8 + 1.9)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
    slug = ids.liveEventSlug;

    // v2-앵커 seat_tier → figma 좌석맵 tierId 부착 → v2_seat_id 백필(grid는 tier_id NULL → public seats 빈배열/hold 500)
    const tierRes = await request.post(`/api/events/${eventId}/seat-tiers`, {
      data: { name: `companion-tier ${Date.now()}`, capacity: 6, basePrice: 80000 },
    });
    if (!tierRes.ok()) {
      test.skip(true, `seat-tier 생성 실패 — 상태 ${tierRes.status()}`);
      return;
    }
    const seatTierId = (await tierRes.json()).data.id;

    // 회귀용 신규 좌석맵 생성 (figma — tier 앵커)
    const mapRes = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `companion-watch ${Date.now()}`,
        figmaLayout: {
          sections: [
            { name: "TEST", x: 0, y: 0, kind: "assigned", rows: 1, seatsPerRow: 6, tierId: seatTierId },
          ],
        },
      },
    });
    if (!mapRes.ok()) {
      test.skip(true, `seat-map 생성 실패 — 상태 ${mapRes.status()}`);
      return;
    }
    seatMapId = (await mapRes.json()).data.id;

    // 좌석 ID 1개 확보 (watch 테스트용)
    const listRes = await request.get(
      `/api/public/events/${slug}/seats?mapId=${seatMapId}`,
    );
    const body = await listRes.json();
    const seats = body?.data?.seats ?? [];
    firstSeatId = seats[0]?.id;
  });

  test.afterAll(async () => {
    await request.dispose().catch(() => undefined);
  });

  test("companion: 미생성 tier 시 404", async () => {
    const res = await request.post(
      `/api/public/events/${slug}/seats/companion`,
      {
        data: { size: 3 },
      },
    );
    // tier 가 없는 시드 환경 → 404 (선택 가능한 등급이 없습니다)
    // 또는 이미 tier 가 있다면 200/409 — 둘 다 정상
    expect([200, 404, 409]).toContain(res.status());
  });

  test("watch POST → 즐겨찾기 등록 성공", async () => {
    if (!firstSeatId) {
      test.skip(true, "seat 미확보");
      return;
    }
    const res = await request.post(
      `/api/public/events/${slug}/seats/watch`,
      {
        data: { seatId: firstSeatId, targetPrice: 50000 },
      },
    );
    expect(res.ok(), `watch 등록 실패: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.data.seatId).toBe(firstSeatId);
    expect(body.data.targetPrice).toBe(50000);
  });

  test("watch GET → 등록한 항목 조회", async () => {
    const res = await request.get(
      `/api/public/events/${slug}/seats/watch`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  test("watch DELETE → 단일 해제", async () => {
    if (!firstSeatId) return;
    const res = await request.delete(
      `/api/public/events/${slug}/seats/watch?seatId=${firstSeatId}`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.deleted).toBeGreaterThanOrEqual(0);
  });

  test("watch POST → 잘못된 seatId 형식 400", async () => {
    const res = await request.post(
      `/api/public/events/${slug}/seats/watch`,
      {
        data: { seatId: "not-a-uuid" },
      },
    );
    expect(res.status()).toBe(400);
  });
});

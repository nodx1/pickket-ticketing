/**
 * 좌석 hold race condition E2E — Phase 12
 *
 * 5개 동시 hold 요청이 동일 좌석에 몰렸을 때 정확히 1개만 성공해야 한다.
 * SELECT ... FOR UPDATE SKIP LOCKED 가 제대로 동작하는지 검증.
 *
 * Phase 2 + Phase 6 의존. 미구현 환경에서는 skip.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

let request: APIRequestContext;
let eventId: string;
  let slug: string;
let mapId: string;
let seatIds: string[] = [];

async function fetchSeats() {
  const res = await request.get(`/api/public/events/${slug}/seats?mapId=${mapId}`);
  if (!res.ok()) return null;
  const body = await res.json().catch(() => null);
  const raw = body?.data?.seats ?? body?.data ?? body;
  return Array.isArray(raw) ? (raw as Array<{ id: string; status: string }>) : null;
}

test.describe.serial("좌석 hold 동시성 (Phase 10~11)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
    slug = ids.liveEventSlug;

    // v2-앵커 seat_tier → figma 좌석맵 tierId 부착 → v2_seat_id 백필(grid는 tier_id NULL → hold 500)
    const tierRes = await request.post(`/api/events/${eventId}/seat-tiers`, {
      data: { name: `race-tier ${Date.now()}`, capacity: 4, basePrice: 80000 },
    });
    if (!tierRes.ok()) {
      test.skip(true, `seat-tier 생성 실패 — 상태 ${tierRes.status()}`);
      return;
    }
    const seatTierId = (await tierRes.json()).data.id;

    const mapRes = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `race ${Date.now()}`,
        figmaLayout: {
          sections: [
            { name: "RACE", x: 0, y: 0, kind: "assigned", rows: 1, seatsPerRow: 4, tierId: seatTierId },
          ],
        },
      },
    });
    if (!mapRes.ok()) {
      test.skip(true, `seat-map 생성 실패 — 상태 ${mapRes.status()}`);
      return;
    }
    const mapBody = await mapRes.json();
    mapId = mapBody.data.id;

    const seats = await fetchSeats();
    if (!seats) {
      test.skip(true, "public seats 조회 API 미구현");
      return;
    }
    seatIds = seats
      .filter((s) => s.status === "available")
      .slice(0, 2)
      .map((s) => s.id);
  });

  test.afterAll(async () => {
    await request.dispose().catch(() => undefined);
  });

  test("5 concurrent hold → 정확히 1건만 성공", async () => {
    if (seatIds.length === 0) {
      test.skip(true, "이전 단계 스킵");
      return;
    }

    const requests = Array.from({ length: 5 }, () =>
      request.post(`/api/public/events/${slug}/seats/hold`, {
        data: { seatIds },
      }),
    );
    const responses = await Promise.all(requests);

    // hold API 미구현 시 전부 404
    if (responses.every((r) => r.status() === 404)) {
      test.skip(true, "hold API 미구현");
      return;
    }

    const successCount = (
      await Promise.all(
        responses.map(async (r) => {
          if (!r.ok()) return 0;
          const body = await r.json().catch(() => null);
          const held = body?.data?.held ?? body?.data?.heldSeatIds ?? [];
          return Array.isArray(held) && held.length === seatIds.length ? 1 : 0;
        }),
      )
    ).reduce((a: number, b: number) => a + b, 0);

    expect(successCount).toBe(1);
  });
});

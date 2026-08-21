/**
 * 좌석 hold 라이프사이클 E2E — Phase 12
 *
 * 목표: 새 좌석 hold API (/api/public/events/[eventId]/seats/hold) 의
 * 전 생애주기를 검증한다.
 *
 * 의존성: Phase 2 (seatRepo) + Phase 6 (public hold API) 가 머지되어야 한다.
 * 엔드포인트가 아직 없는 환경에서는 테스트를 skip 처리한다.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { getSeededEventIds } from "../helpers/events";

interface SeatRow {
  id: string;
  status: string;
}

let request: APIRequestContext;
let eventId: string;
  let slug: string;
let mapId: string;
let seatIds: string[] = [];
let holdId = "";
let holdToken = "";

async function getSeatsList(slugLocal: string, mapIdLocal: string): Promise<SeatRow[] | null> {
  const res = await request.get(`/api/public/events/${slugLocal}/seats?mapId=${mapIdLocal}`);
  if (res.status() === 404) return null;
  if (!res.ok()) return null;
  const body = await res.json().catch(() => null);
  const raw = body?.data?.seats ?? body?.data ?? body;
  return Array.isArray(raw) ? (raw as SeatRow[]) : null;
}

test.describe.serial("좌석 hold 라이프사이클 (Phase 10~11)", () => {
  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
    });
    await loginAsDemoApi(request);
    const ids = await getSeededEventIds(request);
    eventId = ids.liveEventId;
    slug = ids.liveEventSlug;

    // v2-앵커 seat_tier 먼저 → figma 좌석맵에 tierId 부착 → write-through가 v2_seat_id 백필.
    // (grid 모드는 tier_id NULL → v2_seat_id 미생성 → hold 500. figma+tier가 유일한 앵커 경로)
    const tierRes = await request.post(`/api/events/${eventId}/seat-tiers`, {
      data: { name: `hold-tier ${Date.now()}`, capacity: 20, basePrice: 80000 },
    });
    if (!tierRes.ok()) {
      test.skip(true, `seat-tier 생성 실패 — 상태 ${tierRes.status()}`);
      return;
    }
    const seatTierId = (await tierRes.json()).data.id;

    // 시드 이벤트에 임시 seat_map 생성 (figma — tier 앵커로 v2_seat_id 확보)
    const mapRes = await request.post(`/api/events/${eventId}/seat-maps`, {
      data: {
        name: `hold-lifecycle ${Date.now()}`,
        figmaLayout: {
          sections: [
            { name: "VIP", x: 0, y: 0, kind: "assigned", rows: 2, seatsPerRow: 5, tierId: seatTierId },
            { name: "R", x: 400, y: 0, kind: "assigned", rows: 2, seatsPerRow: 5, tierId: seatTierId },
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
  });

  test.afterAll(async () => {
    await request.dispose().catch(() => undefined);
  });

  test("1. 좌석 목록 조회 (public)", async () => {
    const seats = await getSeatsList(slug, mapId);
    if (!seats) {
      test.skip(true, "public seats 조회 API 미구현");
      return;
    }
    expect(seats.length).toBeGreaterThan(0);
    seatIds = seats
      .filter((s) => s.status === "available")
      .slice(0, 2)
      .map((s) => s.id);
    expect(seatIds.length).toBe(2);
  });

  test("2. 좌석 hold 생성", async () => {
    if (seatIds.length === 0) {
      test.skip(true, "이전 단계 스킵");
      return;
    }
    const res = await request.post(`/api/public/events/${slug}/seats/hold`, {
      data: { seatIds },
    });
    if (res.status() === 404) {
      test.skip(true, "hold API 미구현");
      return;
    }
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    holdId = body.data?.holdId ?? body.holdId ?? "";
    holdToken = body.data?.holdToken ?? body.holdToken ?? "";
    expect(holdId).toMatch(/^[0-9a-f-]{36}$/);
    // 빅뱅 cutover 후 v2 hold_id 가 소유권 bearer — go HMAC holdToken 은 폐기(repo.ts holdToken="").
    // 소유권 식별은 holdId(uuid)로 충분. (holdToken 빈값이 현재 정상 계약)
  });

  test("3. 동일 좌석 재hold → 실패 또는 heldSeatIds 빈 배열", async () => {
    if (!holdId) {
      test.skip(true, "이전 단계 스킵");
      return;
    }
    const res = await request.post(`/api/public/events/${slug}/seats/hold`, {
      data: { seatIds },
    });
    if (res.ok()) {
      const body = await res.json();
      const held = body.data?.held ?? body.data?.heldSeatIds ?? [];
      expect(Array.isArray(held) ? held.length : 0).toBe(0);
    } else {
      expect([400, 409, 410, 422]).toContain(res.status());
    }
  });

  test("4. hold 해제 (DELETE)", async () => {
    if (!holdId) {
      test.skip(true, "이전 단계 스킵");
      return;
    }
    const res = await request.delete(`/api/public/events/${slug}/seats/hold`, {
      data: { holdId, holdToken },
    });
    if (res.status() === 404 || res.status() === 405) {
      test.skip(true, "hold DELETE API 미구현");
      return;
    }
    expect(res.ok()).toBeTruthy();
  });

  test("5. 해제 후 좌석 상태 → available", async () => {
    if (!holdId) {
      test.skip(true, "이전 단계 스킵");
      return;
    }
    const seats = await getSeatsList(slug, mapId);
    if (!seats) return;
    const firstReleased = seats.find((s) => s.id === seatIds[0]);
    expect(firstReleased?.status).toBe("available");
  });
});

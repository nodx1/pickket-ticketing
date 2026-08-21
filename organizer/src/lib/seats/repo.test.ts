import { afterEach, describe, expect, it, vi } from "vitest";

import type { SeatListResult, SeatReadRow } from "@/lib/v2/commerce-client";

/**
 * seatRepo — 레벨2 컷오버 T1 계약.
 *
 * go `seats` 를 SELECT 하던 READ 들이 v2 live read(list_seats)로 옮겨졌다. 여기서 고정하는 계약:
 *  1. 좌석 id = **v2 canonical seat_id**(external_ref 는 멱등키로 따라온다).
 *  2. 맵 소속 판정 = external_ref(`smseat:{mapId}:{hash}`) prefix — go seats.seat_map_id 대체.
 *     맵을 알 수 없는 레거시 ref 는 배제하지 않는다(단일맵 계약).
 *  3. hold 결과 held/failed 는 v2 응답과 **정확히** 대조된다(부분 홀드 식별).
 *  4. PoolClient 를 받지 않는다 — go DB 미접근(외부호출을 go 트랜잭션에 넣지 않기 위함).
 */
const h = vi.hoisted(() => {
  class FakeV2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    listSeats: vi.fn(),
    holdInventory: vi.fn(),
    releaseInventory: vi.fn(),
    confirmInventory: vi.fn(),
    blockSeats: vi.fn(),
    FakeV2CommerceError,
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  listSeats: (...a: unknown[]) => h.listSeats(...a),
  holdInventory: (...a: unknown[]) => h.holdInventory(...a),
  releaseInventory: (...a: unknown[]) => h.releaseInventory(...a),
  confirmInventory: (...a: unknown[]) => h.confirmInventory(...a),
  blockSeats: (...a: unknown[]) => h.blockSeats(...a),
  V2CommerceError: h.FakeV2CommerceError,
}));

import { seatRepo } from "./repo";

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * external_ref 는 좌석 고유키(fetchV2SeatLiveMap 이 이 값으로 키잉)라 좌석마다 달라야 한다 →
 * 명시하지 않으면 seat_id 로 파생한다(`smseat:map-a:{seat_id}`).
 */
function seat(over: Partial<SeatReadRow>): SeatReadRow {
  const base: SeatReadRow = {
    seat_id: "v2-seat-1",
    external_ref: null,
    tier_id: "tier-1",
    section: "A",
    row_number: 1,
    seat_number: 1,
    status: "available",
    quality_score: 0.5,
    x: 10,
    y: 20,
    label: "A-1",
    is_obstructed: false,
    ...over,
  };
  return {
    ...base,
    external_ref: base.external_ref ?? `smseat:map-a:${base.seat_id}`,
  };
}

function listResult(seats: SeatReadRow[]): SeatListResult {
  return {
    seats,
    status_counts: { available: seats.length },
    total_seats: seats.length,
    page_count: seats.length,
    limit: 5000,
    offset: 0,
  };
}

describe("seatRepo.getByEvent — v2 live read 투영", () => {
  it("좌석 id 로 v2 canonical seat_id 를 쓰고 external_ref 를 함께 노출한다", async () => {
    h.listSeats.mockResolvedValueOnce(
      listResult([seat({ seat_id: "v2-seat-42", external_ref: "smseat:map-a:abc0000000000001" })]),
    );

    const seats = await seatRepo.getByEvent("v2evt");

    expect(h.listSeats).toHaveBeenCalledWith("v2evt", { limit: 5000, offset: 0 });
    expect(seats).toHaveLength(1);
    expect(seats[0].id).toBe("v2-seat-42");
    expect(seats[0].externalRef).toBe("smseat:map-a:abc0000000000001");
    expect(seats[0].section).toBe("A");
    expect(seats[0].row).toBe("1");
    expect(seats[0].seatNumber).toBe("1");
  });

  it("mapIds 필터는 external_ref prefix 로 판정한다(타 배치도 좌석 배제)", async () => {
    h.listSeats.mockResolvedValueOnce(
      listResult([
        seat({ seat_id: "s-a", external_ref: "smseat:map-a:0000000000000001" }),
        seat({ seat_id: "s-b", external_ref: "smseat:map-b:0000000000000002", section: "B" }),
      ]),
    );

    const seats = await seatRepo.getByEvent("v2evt", { mapIds: ["map-a"] });

    expect(seats.map((s) => s.id)).toEqual(["s-a"]);
  });

  it("맵을 알 수 없는 레거시 external_ref 는 필터에서 배제하지 않는다", async () => {
    h.listSeats.mockResolvedValueOnce(
      listResult([
        seat({ seat_id: "s-legacy", external_ref: "8f0b4c2e-1111-2222-3333-444455556666" }),
      ]),
    );

    const seats = await seatRepo.getByEvent("v2evt", { mapIds: ["map-a"] });

    expect(seats.map((s) => s.id)).toEqual(["s-legacy"]);
  });

  it("status/tierId 필터 + section·row·좌석번호(숫자) 정렬", async () => {
    h.listSeats.mockResolvedValueOnce(
      listResult([
        seat({ seat_id: "s-10", section: "A", row_number: 1, seat_number: 10 }),
        seat({ seat_id: "s-2", section: "A", row_number: 1, seat_number: 2 }),
        seat({ seat_id: "s-sold", section: "A", row_number: 1, seat_number: 1, status: "sold" }),
        seat({ seat_id: "s-other-tier", section: "A", row_number: 1, seat_number: 3, tier_id: "tier-2" }),
      ]),
    );

    const seats = await seatRepo.getByEvent("v2evt", { status: "available", tierId: "tier-1" });

    // seat_number 는 문자열 비교가 아니라 정수 비교(2 < 10).
    expect(seats.map((s) => s.id)).toEqual(["s-2", "s-10"]);
  });

  it("알 수 없는 v2 status 는 available 로 낙관하지 않는다(초과판매 방지)", async () => {
    h.listSeats.mockResolvedValueOnce(
      listResult([seat({ seat_id: "s-x", status: "PENDING_SOMETHING" })]),
    );

    const seats = await seatRepo.getByEvent("v2evt");

    expect(seats[0].status).toBe("reserved");
  });
});

describe("seatRepo.getAvailableByTier / getBestAvailable", () => {
  it("가용 좌석을 품질점수 내림차순으로 limit 만큼 준다", async () => {
    h.listSeats.mockResolvedValueOnce(
      listResult([
        seat({ seat_id: "s-low", seat_number: 1, quality_score: 0.1 }),
        seat({ seat_id: "s-high", seat_number: 2, quality_score: 0.9 }),
        seat({ seat_id: "s-mid", seat_number: 3, quality_score: 0.5 }),
      ]),
    );

    const seats = await seatRepo.getAvailableByTier("v2evt", "tier-1", 2);

    expect(seats.map((s) => s.id)).toEqual(["s-high", "s-mid"]);
  });

  it("인접 좌석 우선 추천 + 시야방해석 제외", async () => {
    h.listSeats.mockResolvedValueOnce(
      listResult([
        // 같은 열 인접 2석(품질 낮음)
        seat({ seat_id: "adj-1", section: "A", row_number: 1, seat_number: 1, quality_score: 0.4 }),
        seat({ seat_id: "adj-2", section: "A", row_number: 1, seat_number: 2, quality_score: 0.4 }),
        // 품질은 높지만 떨어져 있는 좌석 + 시야방해석
        seat({ seat_id: "far", section: "B", row_number: 1, seat_number: 9, quality_score: 0.99 }),
        seat({ seat_id: "blocked-view", section: "A", row_number: 1, seat_number: 3, quality_score: 1, is_obstructed: true }),
      ]),
    );

    const seats = await seatRepo.getBestAvailable("v2evt", { quantity: 2, preferAdjacent: true });

    expect(seats.map((s) => s.id)).toEqual(["adj-1", "adj-2"]);
  });
});

describe("seatRepo 재고 write — v2 write-through(앵커 해석 없음)", () => {
  it("holdSeats 는 v2 canonical id 를 그대로 보내고 held/failed 를 정확히 가른다", async () => {
    h.holdInventory.mockResolvedValueOnce({
      hold_id: "hold-1",
      expires_at: "2026-07-27T00:10:00Z",
      held: ["seat-b"], // seat-a 는 남이 선점
    });

    const result = await seatRepo.holdSeats({
      v2EventId: "v2evt",
      seatIds: ["seat-a", "seat-b"],
      ttlSeconds: 300,
    });

    expect(h.holdInventory).toHaveBeenCalledWith({
      event_id: "v2evt",
      seat_ids: ["seat-a", "seat-b"],
      user_id: undefined, // 익명 → held_by NULL, hold_id 가 bearer 소유권
      ttl_seconds: 300,
    });
    expect(result.held).toEqual(["seat-b"]);
    expect(result.failed).toEqual(["seat-a"]);
    expect(result.holdId).toBe("hold-1");
    expect(result.holdToken).toBe(""); // go HMAC 토큰 폐기
  });

  it("빈 좌석 홀드는 v2 를 호출하지 않고 400 으로 거부", async () => {
    await expect(seatRepo.holdSeats({ v2EventId: "v2evt", seatIds: [] })).rejects.toMatchObject({
      status: 400,
    });
    expect(h.holdInventory).not.toHaveBeenCalled();
  });

  it("releaseByHoldId 는 hold_id 키로만 해제한다(세션/HMAC 검증 없음·멱등)", async () => {
    h.releaseInventory.mockResolvedValue({ released: 3 });

    const released = await seatRepo.releaseByHoldId("hold-1");
    // 재시도(동시 2회) — v2 가 멱등 수렴, go 는 상태를 갖지 않는다.
    h.releaseInventory.mockResolvedValueOnce({ released: 0 });
    const again = await seatRepo.releaseByHoldId("hold-1");

    expect(h.releaseInventory).toHaveBeenNthCalledWith(1, { hold_id: "hold-1" });
    expect(released).toBe(3);
    expect(again).toBe(0);
  });

  it("blockSeats 는 v2 canonical seat_id 를 그대로 전달", async () => {
    h.blockSeats.mockResolvedValueOnce({ affected: 2 });

    const affected = await seatRepo.blockSeats("v2evt", ["seat-a", "seat-b"]);

    expect(h.blockSeats).toHaveBeenCalledWith({ event_id: "v2evt", seat_ids: ["seat-a", "seat-b"] });
    expect(affected).toBe(2);
  });

  it("go 직접 마킹 경로(markSold/markReserved)는 계속 차단된다", async () => {
    await expect(seatRepo.markSold({ seatIds: ["s"], orderId: "o" })).rejects.toThrow(/markSold 폐기/);
    await expect(seatRepo.markReserved({ seatIds: ["s"], orderId: "o" })).rejects.toThrow(
      /markReserved 폐기/,
    );
  });
});

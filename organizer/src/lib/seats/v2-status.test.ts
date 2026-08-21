import { afterEach, describe, expect, it, vi } from "vitest";

import type { SeatListResult, SeatReadRow } from "@/lib/v2/commerce-client";

// listSeats 격리 (hoisted 홀더).
const h = vi.hoisted(() => ({ listSeats: vi.fn() }));
vi.mock("@/lib/v2/commerce-client", () => ({
  listSeats: (...a: unknown[]) => h.listSeats(...a),
}));

import { fetchV2SeatLiveMap } from "./v2-status";

afterEach(() => h.listSeats.mockReset());

function seat(over: Partial<SeatReadRow>): SeatReadRow {
  return {
    seat_id: "v2-seat-1",
    external_ref: "go-seat-1",
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
}

function result(seats: SeatReadRow[]): SeatListResult {
  return {
    seats,
    status_counts: { available: seats.length },
    total_seats: seats.length,
    page_count: seats.length,
    limit: 5000,
    offset: 0,
  };
}

describe("fetchV2SeatLiveMap — read-flip: status + 좌표를 external_ref 로 키잉", () => {
  it("external_ref 로 v2 live 행(seat_id·status·x·y·label·is_obstructed·quality)을 투영", async () => {
    h.listSeats.mockResolvedValueOnce(
      result([
        seat({
          seat_id: "v2-seat-77",
          external_ref: "smseat:map-1:00112233aabbccdd",
          status: "sold",
          x: 100.25,
          y: 40.5,
          label: "R-3",
          is_obstructed: true,
          quality_score: 0.9,
          tier_id: "tier-9",
        }),
      ]),
    );
    const { byGoSeatId, statusCounts, totalSeats } = await fetchV2SeatLiveMap("v2evt");
    const live = byGoSeatId.get("smseat:map-1:00112233aabbccdd");
    expect(live).toEqual({
      // 레벨2 컷오버 T1 — 좌석 정본 id = v2 canonical seat_id(go seats.id 소멸).
      seatId: "v2-seat-77",
      externalRef: "smseat:map-1:00112233aabbccdd",
      status: "sold",
      tierId: "tier-9",
      x: 100.25,
      y: 40.5,
      label: "R-3",
      isObstructed: true,
      qualityScore: 0.9,
      // 레벨2 3차 3.1 — 개별 맵 GET go select 제거 → 좌석 자연키도 v2 에서 투영.
      section: "A",
      row: "1",
      seatNumber: "1",
    });
    expect(statusCounts).toEqual({ available: 1 });
    expect(totalSeats).toBe(1);
  });

  it("external_ref 없는(레거시 미키잉) v2 좌석은 맵에서 제외 → 앵커 매칭 불가", async () => {
    h.listSeats.mockResolvedValueOnce(
      result([seat({ external_ref: null, status: "held" })]),
    );
    const { byGoSeatId } = await fetchV2SeatLiveMap("v2evt");
    expect(byGoSeatId.size).toBe(0);
  });

  it("x/y null 도 그대로 보존(정규화 계층에서 폴백 판단)", async () => {
    h.listSeats.mockResolvedValueOnce(
      result([seat({ external_ref: "go-seat-2", x: null, y: null })]),
    );
    const live = (await fetchV2SeatLiveMap("v2evt")).byGoSeatId.get("go-seat-2");
    expect(live?.x).toBeNull();
    expect(live?.y).toBeNull();
  });
});

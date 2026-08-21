import { afterEach, describe, expect, it, vi } from "vitest";

// ── 레벨2 컷오버 T2-EVT ──
// loadOwnedRaffleEvent 는 더 이상 go `events` 를 읽지 않는다. 소유 게이트·앵커·raffle_enabled 전부
// v2 상세(getEvent + organizer_ref)에서 온다 → go pool 대신 commerce-client 를 모킹한다.
const h = vi.hoisted(() => {
  class V2CommerceErrorMock extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    V2CommerceError: V2CommerceErrorMock,
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  getEvent: h.getEvent,
  getEventBySlug: h.getEventBySlug,
  V2CommerceError: h.V2CommerceError,
}));

import { EventAccessError } from "@/lib/v2/event-access";
import type { RaffleDrawResult } from "@/lib/v2/commerce-client";

import { loadOwnedRaffleEvent, toGoDraw } from "./_shared";

afterEach(() => {
  h.getEvent.mockReset();
});

describe("loadOwnedRaffleEvent (테넌트 경계 — v2 organizer_ref)", () => {
  it("소유 이벤트는 앵커·raffle_enabled 를 반환", async () => {
    h.getEvent.mockResolvedValueOnce({ event_id: "go-1", raffle_enabled: true });
    const r = await loadOwnedRaffleEvent("go-1", "acc-1");
    expect(r).toEqual({ v2EventId: "go-1", raffleEnabled: true });
    // accountId 가 organizer_ref 로 전달돼야 한다(크로스테넌트 경계 실증 — 빠지면 타 계정 추첨 가능).
    expect(h.getEvent).toHaveBeenCalledWith("go-1", { organizerRef: "acc-1" });
  });

  it("미소유(다른 account)·부재 이벤트는 null (크로스테넌트 차단)", async () => {
    // v2 는 organizer_ref 불일치를 404 로 응답한다(존재 사실 비노출).
    h.getEvent.mockRejectedValueOnce(new h.V2CommerceError("not found", 404));
    const r = await loadOwnedRaffleEvent("go-1", "other-acc");
    expect(r).toBeNull();
  });

  it("raffle_enabled 미전달이면 false (경품 미활성으로 보수 판정)", async () => {
    h.getEvent.mockResolvedValueOnce({ event_id: "go-1" });
    const r = await loadOwnedRaffleEvent("go-1", "acc-1");
    expect(r).toEqual({ v2EventId: "go-1", raffleEnabled: false });
  });

  it("v2 응답불가는 null 로 뭉개지 않고 EventAccessError 를 던진다", async () => {
    h.getEvent.mockRejectedValueOnce(new h.V2CommerceError("bad gateway", 502));
    await expect(loadOwnedRaffleEvent("go-1", "acc-1")).rejects.toBeInstanceOf(EventAccessError);
  });
});

describe("toGoDraw (v2 snake → go camel)", () => {
  it("당첨 raffle_number·seed·시각·풀크기를 정규화", () => {
    const v2: RaffleDrawResult = {
      draw_id: "d-1",
      event_id: "v2-1",
      draw_key: "round-1",
      seed: "public-seed-abc",
      winner_count: 3,
      pool_size: 42,
      winning_numbers: [7, 12, 30],
      executed_by: "user-1",
      executed_at: "2026-07-21T09:00:00Z",
    };
    expect(toGoDraw(v2)).toEqual({
      drawId: "d-1",
      drawKey: "round-1",
      seed: "public-seed-abc",
      winnerCount: 3,
      poolSize: 42,
      winningNumbers: [7, 12, 30],
      executedBy: "user-1",
      executedAt: "2026-07-21T09:00:00Z",
    });
  });
});

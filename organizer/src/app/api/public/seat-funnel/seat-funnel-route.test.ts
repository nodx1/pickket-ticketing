import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// 레벨2 컷오버 T2-REST/W2-PUB — 좌석 퍼널 수집 회귀.
//
// 검증 대상:
//  ① go DB 를 **전혀 건드리지 않는다**(seat_funnel_events INSERT 도, 앵커 SELECT 도 없음).
//  ② 수집은 URL 의 event id 를 그대로 v2 canonical id 로 전달한다(ID 승격 = 항등).
//  ③ **fail-soft 계약 유지** — v2 수집이 실패해도 200 (분석이 구매 경로를 막지 않는다).
//  ④ 스키마 위반은 네트워크를 건드리지 않고 200.

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool }));

const { collectSeatFunnelEvent } = vi.hoisted(() => ({
  collectSeatFunnelEvent: vi.fn(),
}));
vi.mock("@/lib/v2/commerce-client", () => ({ collectSeatFunnelEvent }));

vi.mock("@/lib/seats/metrics", () => ({
  seatMetrics: { incrementFunnelEvent: vi.fn() },
}));

import { POST } from "@/app/api/public/seat-funnel/route";

// zod uuid 검증을 통과하는 값이어야 한다(버전 nibble 4 / variant 8). 아니면 스키마
// 단계에서 fail-soft 200 으로 빠져 테스트가 무의미하게 통과한다.
const EVENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function req(body: unknown): NextRequest {
  return {
    json: async () => body,
    cookies: { get: () => ({ value: "sess-abc" }) },
  } as unknown as NextRequest;
}

const BODY = {
  eventId: EVENT_ID,
  seatMapId: null,
  step: "select" as const,
  seatCount: 2,
  metadata: { section: "A" },
};

beforeEach(() => {
  getPool.mockReset();
  collectSeatFunnelEvent.mockReset();
  collectSeatFunnelEvent.mockResolvedValue({ accepted: true });
});

describe("좌석 퍼널 수집 — v2 단일 경로 (T2-REST · W2-PUB)", () => {
  it("go DB 왕복 없이 canonical event id 로 수집한다", async () => {
    const res = await POST(req(BODY));

    expect(res.status).toBe(200);
    // ① go DB 미사용 — 앵커 SELECT 조차 없다(비콘마다 붙던 왕복 제거).
    expect(getPool).not.toHaveBeenCalled();
    // ② ID 승격: URL event id == v2 canonical id
    expect(collectSeatFunnelEvent).toHaveBeenCalledTimes(1);
    const [eventId, payload] = collectSeatFunnelEvent.mock.calls[0]!;
    expect(eventId).toBe(EVENT_ID);
    expect(payload.session_id).toBe("sess-abc");
    expect(payload.step).toBe("select");
    expect(payload.seat_count).toBe(2);
  });

  it("v2 수집이 실패해도 200 을 유지한다 (fail-soft)", async () => {
    collectSeatFunnelEvent.mockRejectedValue(new Error("v2 down"));

    const res = await POST(req(BODY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
  });

  it("스키마 위반(알 수 없는 step)은 DB/네트워크를 건드리지 않고 200", async () => {
    const res = await POST(req({ ...BODY, step: "teleport" }));

    expect(res.status).toBe(200);
    expect(collectSeatFunnelEvent).not.toHaveBeenCalled();
    expect(getPool).not.toHaveBeenCalled();
  });
});

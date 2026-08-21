/**
 * 레벨2 컷오버 T2-PHASE — 판매 단계 v2 클라이언트 회귀.
 *
 * 검증 축:
 *  · go DB `sale_phases` 를 더 이상 읽지 않고 v2 sale-plan 엔드포인트로 간다.
 *  · 계정 소유검증(IDOR 차단)이 v2 호출 **이전에** 걸린다.
 *  · applySalePlan 이 **안정 멱등키**(`sale-plan:{eventId}`)를 쓴다 — 재시도가 중복 적용을 만들지 않는다.
 *  · 게이트 폴백 방향이 안전한 쪽이다: 추첨 메뉴는 false(숨김), 가격 변경은 차단(throw).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getPool: vi.fn(),
  resolveOwned: vi.fn(),
  salePlanRequest: vi.fn(),
}));

// go DB 는 이 경로에서 **한 번도** 열리지 않아야 한다 — 호출되면 테스트가 깨지도록 스파이만 둔다.
vi.mock("@/lib/db/pool", () => ({ getPool: h.getPool }));
// 레벨2 T2-EVT: 소유검증이 go `events` 앵커 → v2 organizer_ref 로 이동.
vi.mock("@/lib/v2/event-access", () => {
  class EventAccessError extends Error {
    constructor(
      message: string,
      readonly reason: "not_found" | "unavailable",
      readonly status: number,
    ) {
      super(message);
      this.name = "EventAccessError";
    }
  }
  return {
    EventAccessError,
    resolveOwnedV2EventId: (...a: unknown[]) => h.resolveOwned(...a),
  };
});
vi.mock("@/lib/v2/commerce-client", async () => {
  class V2CommerceError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body?: string,
    ) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    V2CommerceError,
    v2SalePlanRequest: (...a: unknown[]) => h.salePlanRequest(...a),
  };
});

import { V2CommerceError } from "@/lib/v2/commerce-client";
import {
  applySalePlan,
  fetchSalePlan,
  hasActiveSalePhase,
  hasLotteryPhase,
  salePlanErrorMessage,
} from "./phase-client";

const EVENT_ID = "11111111-1111-1111-1111-111111111111";
const V2_EVENT_ID = "22222222-2222-2222-2222-222222222222";
const ACCOUNT_ID = "33333333-3333-3333-3333-333333333333";

function phase(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    eventId: V2_EVENT_ID,
    phaseOrder: 1,
    mode: "lottery",
    opensAt: "2026-08-01T00:00:00+00:00",
    closesAt: "2026-08-08T00:00:00+00:00",
    targetQuantity: 100,
    allocatedQuantity: 0,
    status: "scheduled",
    config: { payment_window_hours: 72 },
    ...over,
  };
}

beforeEach(() => {
  h.resolveOwned.mockResolvedValue(V2_EVENT_ID);
});

afterEach(() => {
  h.getPool.mockReset();
  h.resolveOwned.mockReset();
  h.salePlanRequest.mockReset();
});

describe("fetchSalePlan — v2 phase_configs 정본 조회", () => {
  it("소유 이벤트면 v2 sale-plan GET 을 호출하고 결과를 그대로 반환", async () => {
    h.salePlanRequest.mockResolvedValueOnce({
      phases: [phase()],
      current: phase(),
      total: 1,
    });
    const plan = await fetchSalePlan(EVENT_ID, ACCOUNT_ID);
    expect(plan?.total).toBe(1);
    const [method, path] = h.salePlanRequest.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toBe(`/api/v1/internal/events/${V2_EVENT_ID}/sale-plan`);
    // 계정 스코프가 소유검증에 실제로 전달되는지(누락 = 크로스테넌트 누출)
    expect(h.resolveOwned).toHaveBeenCalledWith(EVENT_ID, ACCOUNT_ID);
    // 레벨2 컷오버: 이 경로는 go DB 를 **한 번도** 열지 않는다(sale_phases·events 모두).
    expect(h.getPool).not.toHaveBeenCalled();
  });

  it("타 계정 이벤트면 v2 를 호출하지 않고 null (IDOR 차단)", async () => {
    h.resolveOwned.mockResolvedValueOnce(null);
    const plan = await fetchSalePlan(EVENT_ID, ACCOUNT_ID);
    expect(plan).toBeNull();
    expect(h.salePlanRequest).not.toHaveBeenCalled();
  });

  it("v2 장애는 null 이 아니라 EventAccessError 로 전파 — '단계 없음'으로 위장하지 않는다", async () => {
    // 미소유(null)와 장애를 같은 값으로 뭉개면 라우트가 404 를 주고, 주최자는 판매계획이
    // 사라진 것으로 오인한다. 호출측이 503 으로 구분할 수 있어야 한다.
    const { EventAccessError } = await import("@/lib/v2/event-access");
    h.resolveOwned.mockRejectedValueOnce(
      new EventAccessError("커머스 서버에 연결할 수 없습니다", "unavailable", 502),
    );
    await expect(fetchSalePlan(EVENT_ID, ACCOUNT_ID)).rejects.toBeInstanceOf(EventAccessError);
    expect(h.salePlanRequest).not.toHaveBeenCalled();
  });

  it("hasLotteryPhase 는 페이지 렌더 경로라 재시도 없이 짧은 타임아웃을 쓴다", async () => {
    h.salePlanRequest.mockResolvedValueOnce({ phases: [], current: null, total: 0 });
    await hasLotteryPhase(EVENT_ID, ACCOUNT_ID);
    expect(h.salePlanRequest.mock.calls[0][3]).toEqual({ retries: 0, timeoutMs: 3_000 });
  });
});

describe("applySalePlan — 정본 write 경로", () => {
  it("안정 멱등키 sale-plan:{eventId} 로 PUT 한다(재시도 중복 적용 방지)", async () => {
    h.salePlanRequest.mockResolvedValueOnce({ phases: [phase()], total: 1 });
    const opens = new Date("2026-08-01T00:00:00Z");
    const closes = new Date("2026-08-08T00:00:00Z");

    await applySalePlan(
      EVENT_ID,
      ACCOUNT_ID,
      [{ mode: "lottery", ratioPct: 100, opensAt: opens, closesAt: closes }],
      undefined,
    );

    const [method, path, body, opts] = h.salePlanRequest.mock.calls[0];
    expect(method).toBe("PUT");
    expect(path).toBe(`/api/v1/internal/events/${V2_EVENT_ID}/sale-plan`);
    expect(opts).toEqual({ idempotencyKey: `sale-plan:${EVENT_ID}` });
    expect(body).toEqual({
      phases: [
        {
          mode: "lottery",
          ratio_pct: 100,
          opens_at: opens.toISOString(),
          closes_at: closes.toISOString(),
          fanclub_id: null,
        },
      ],
      fcfs_opens_at: null,
    });
  });

  it("선착순 단독(phases 비어있음)이면 fcfs_opens_at 을 전달한다", async () => {
    h.salePlanRequest.mockResolvedValueOnce({ phases: [phase({ mode: "fcfs_residual" })], total: 1 });
    const fcfs = new Date("2026-08-02T03:00:00Z");
    await applySalePlan(EVENT_ID, ACCOUNT_ID, [], fcfs);
    const body = h.salePlanRequest.mock.calls[0][2] as Record<string, unknown>;
    expect(body.phases).toEqual([]);
    expect(body.fcfs_opens_at).toBe(fcfs.toISOString());
  });

  it("membership_presale 의 fanclubId 를 v2 로 전달(결제창·팬클럽 영속의 입력)", async () => {
    h.salePlanRequest.mockResolvedValueOnce({ phases: [], total: 0 });
    const fanclubId = "44444444-4444-4444-4444-444444444444";
    await applySalePlan(
      EVENT_ID,
      ACCOUNT_ID,
      [
        {
          mode: "membership_presale",
          ratioPct: 100,
          opensAt: new Date("2026-08-01T00:00:00Z"),
          closesAt: new Date("2026-08-03T00:00:00Z"),
          fanclubId,
        },
      ],
      undefined,
    );
    const body = h.salePlanRequest.mock.calls[0][2] as {
      phases: Array<{ fanclub_id: string | null }>;
    };
    expect(body.phases[0].fanclub_id).toBe(fanclubId);
  });

  it("미소유 이벤트면 v2 write 를 시도하지 않는다", async () => {
    h.resolveOwned.mockResolvedValueOnce(null);
    const result = await applySalePlan(EVENT_ID, ACCOUNT_ID, [], new Date());
    expect(result).toBeNull();
    expect(h.salePlanRequest).not.toHaveBeenCalled();
  });

  it("write 경로도 read 와 같은 소유검증 한 경로를 쓴다 — go DB 미접근", async () => {
    // T2-EVT 앵커 폐기 전에는 write 만 `ensure: true` 로 멱등 createEvent 를 걸었다.
    // 앵커가 사라져 '미확립' 상태 자체가 없으므로 그 분기도 소멸했다.
    h.salePlanRequest.mockResolvedValueOnce({ phases: [], total: 0 });
    await applySalePlan(EVENT_ID, ACCOUNT_ID, [], new Date("2026-08-02T00:00:00Z"));
    expect(h.resolveOwned).toHaveBeenCalledWith(EVENT_ID, ACCOUNT_ID);
    expect(h.getPool).not.toHaveBeenCalled();
    expect(h.salePlanRequest.mock.calls[0][1]).toBe(
      `/api/v1/internal/events/${V2_EVENT_ID}/sale-plan`,
    );
  });
});

describe("게이트 폴백 방향", () => {
  it("hasLotteryPhase: 추첨 계열 단계가 있으면 true", async () => {
    h.salePlanRequest.mockResolvedValueOnce({
      phases: [phase({ mode: "waitlist_promotion" })],
      current: null,
      total: 1,
    });
    expect(await hasLotteryPhase(EVENT_ID, ACCOUNT_ID)).toBe(true);
  });

  it("hasLotteryPhase: 선착순만 있으면 false", async () => {
    h.salePlanRequest.mockResolvedValueOnce({
      phases: [phase({ mode: "fcfs_residual" })],
      current: null,
      total: 1,
    });
    expect(await hasLotteryPhase(EVENT_ID, ACCOUNT_ID)).toBe(false);
  });

  it("hasLotteryPhase: v2 조회 실패는 false(메뉴 숨김)로 폴백 — 렌더를 깨지 않는다", async () => {
    h.salePlanRequest.mockRejectedValueOnce(new V2CommerceError("v2 down", 502));
    expect(await hasLotteryPhase(EVENT_ID, ACCOUNT_ID)).toBe(false);
  });

  it("hasActiveSalePhase: open/allocating 단계가 있으면 true(가격 변경 차단)", async () => {
    h.salePlanRequest.mockResolvedValueOnce({
      phases: [phase({ status: "closed" }), phase({ id: "p2", status: "allocating" })],
      current: null,
      total: 2,
    });
    expect(await hasActiveSalePhase(EVENT_ID, ACCOUNT_ID)).toBe(true);
  });

  it("hasActiveSalePhase: v2 조회 실패는 throw — 판매중 여부를 모른 채 가격을 바꾸지 않는다", async () => {
    h.salePlanRequest.mockRejectedValueOnce(new V2CommerceError("v2 down", 502));
    await expect(hasActiveSalePhase(EVENT_ID, ACCOUNT_ID)).rejects.toBeInstanceOf(
      V2CommerceError,
    );
  });
});

describe("salePlanErrorMessage — 주최자에게 보여줄 한국어 메시지 추출", () => {
  it("v2 에러 봉투 body 의 message 를 우선 사용", () => {
    const err = new V2CommerceError(
      "VALIDATION_ERROR: ignored",
      400,
      JSON.stringify({
        ok: false,
        error: { code: "VALIDATION_ERROR", message: "판매 단계 비율 합계가 100% 여야 합니다" },
      }),
    );
    expect(salePlanErrorMessage(err, "폴백")).toBe(
      "판매 단계 비율 합계가 100% 여야 합니다",
    );
  });

  it("body 가 없으면 message 의 CODE: 접두어를 제거", () => {
    const err = new V2CommerceError("PHASE_LOCKED: 이미 진행중인 판매 단계가 있습니다", 400);
    expect(salePlanErrorMessage(err, "폴백")).toBe(
      "이미 진행중인 판매 단계가 있습니다",
    );
  });

  it("추출할 메시지가 없으면 폴백", () => {
    const err = new V2CommerceError("", 502);
    expect(salePlanErrorMessage(err, "판매 방식을 설정하지 못했습니다")).toBe(
      "판매 방식을 설정하지 못했습니다",
    );
  });
});

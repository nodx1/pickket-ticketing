/**
 * 레벨2 T2-EVT — 추첨 라우트의 **v2 응답불가 처리** 회귀.
 *
 * `loadOwnedRaffleEvent` 는 소유 검증이 go `events` → v2 `organizer_ref` 로 옮겨가면서
 * v2 장애에 `EventAccessError(unavailable)` 를 던진다(`_shared.test.ts` 가 그 계약을 고정).
 * 두 라우트 모두 그 호출을 try 밖에 두고 있어 flip 직후 **정체불명 500** 으로 새어 나왔다.
 *
 * 여기서 고정하는 계약:
 *   - v2 장애 → **503**(재시도 가능). 추첨은 방송 중 눌리는 버튼이라 "이벤트 없음(404)"으로
 *     뭉개면 주최자가 재시도를 포기한다.
 *   - 확인 불가 상태에서 **추첨을 실행하지 않는다**(fail-closed — runRaffleDraw 미호출).
 *   - 이력 조회도 확인 불가를 **빈 목록(200)** 으로 숨기지 않는다.
 *   - v2 404(없음/타 계정) → 그대로 404.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getEvent: vi.fn(),
  runRaffleDraw: vi.fn(),
  listRaffleDraws: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/v2/commerce-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/v2/commerce-client")>();
  return {
    ...actual,
    getEvent: h.getEvent,
    runRaffleDraw: h.runRaffleDraw,
    listRaffleDraws: h.listRaffleDraws,
  };
});
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (
        request: Request,
        ctx: { session: { id: string; accountId: string; role: string }; params: unknown },
      ) => Promise<Response>,
    ) =>
    (request: Request, context: { params: Promise<unknown> }) =>
      context.params.then((params) =>
        handler(request, {
          session: { id: "user-1", accountId: "acc-1", role: "organizer" },
          params,
        }),
      ),
}));

import { V2CommerceError } from "@/lib/v2/commerce-client";

import { POST as drawRoute } from "./draw/route";
import { GET as drawsRoute } from "./draws/route";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ eventId: EVENT_ID }) };

// 라우트 시그니처는 NextRequest 를 요구하지만 이 테스트가 쓰는 건 url/method/body 뿐이다.
const drawRequest = () =>
  new Request("http://localhost/raffle/draw", {
    method: "POST",
    body: JSON.stringify({ seed: "public-seed", count: 3 }),
  }) as unknown as NextRequest;
const drawsRequest = () =>
  new Request("http://localhost/raffle/draws") as unknown as NextRequest;

afterEach(() => {
  h.getEvent.mockReset();
  h.runRaffleDraw.mockReset();
  h.listRaffleDraws.mockReset();
  h.logAudit.mockReset();
});

describe("POST /raffle/draw — v2 응답불가", () => {
  it("🔴 503 으로 통지하고 추첨을 실행하지 않는다(fail-closed)", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    const res = await drawRoute(drawRequest(), ctx);
    expect(res.status).toBe(503);
    expect(h.runRaffleDraw).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("잠시 후 다시 시도해주세요");
  });

  it("🔴 확인 불가를 404(이벤트 없음)로 뭉개지 않는다", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("timeout", 504));
    const res = await drawRoute(drawRequest(), ctx);
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(500);
  });

  it("v2 404(없음/타 계정) → 404 (503 으로 승격하지 않는다)", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("not found", 404));
    const res = await drawRoute(drawRequest(), ctx);
    expect(res.status).toBe(404);
    expect(h.runRaffleDraw).not.toHaveBeenCalled();
  });

  it("정상 경로 회귀 — 소유 + raffle_enabled 면 추첨 실행(200)", async () => {
    h.getEvent.mockResolvedValue({ event_id: EVENT_ID, raffle_enabled: true });
    h.runRaffleDraw.mockResolvedValue({
      draw_id: "d-1",
      event_id: EVENT_ID,
      draw_key: null,
      seed: "public-seed",
      winner_count: 3,
      pool_size: 10,
      winning_numbers: [1, 2, 3],
      executed_by: "user-1",
      executed_at: "2026-07-27T00:00:00Z",
    });
    h.logAudit.mockResolvedValue(undefined);
    const res = await drawRoute(drawRequest(), ctx);
    expect(res.status).toBe(200);
    expect(h.runRaffleDraw).toHaveBeenCalledTimes(1);
    // 테넌트 경계가 v2 로 전달됐는지(빠지면 크로스테넌트 추첨 실행).
    expect(h.getEvent).toHaveBeenCalledWith(EVENT_ID, { organizerRef: "acc-1" });
  });
});

describe("GET /raffle/draws — v2 응답불가", () => {
  it("🔴 503 으로 통지한다 — 빈 목록(200)으로 장애를 숨기지 않는다", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    const res = await drawsRoute(drawsRequest(), ctx);
    expect(res.status).toBe(503);
    expect(h.listRaffleDraws).not.toHaveBeenCalled();
  });

  it("v2 404(없음/타 계정) → 404", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("not found", 404));
    const res = await drawsRoute(drawsRequest(), ctx);
    expect(res.status).toBe(404);
  });

  it("정상 경로 회귀 — 이력 목록 반환(200)", async () => {
    h.getEvent.mockResolvedValue({ event_id: EVENT_ID, raffle_enabled: true });
    h.listRaffleDraws.mockResolvedValue({ draws: [] });
    const res = await drawsRoute(drawsRequest(), ctx);
    expect(res.status).toBe(200);
    expect(h.listRaffleDraws).toHaveBeenCalledWith(EVENT_ID);
  });
});

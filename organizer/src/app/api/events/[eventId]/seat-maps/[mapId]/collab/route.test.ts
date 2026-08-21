/**
 * 레벨2 T2-EVT — 협업(collab) presence 라우트의 **fail-closed** 회귀.
 *
 * 이 라우트의 유일한 IDOR 방어는 `verifySeatMapOwnershipV2` 다. T2-EVT 로 그 판정이 go `events`
 * SELECT → v2 `organizer_ref` 조회로 옮겨가면서, v2 응답불가는 `EventAccessError(unavailable)` 로
 * 온다. 옛 코드는 `catch (V2CommerceError) → false` 였고 그 예외는 이제 오지 않는다 →
 * 처리 없이 두면 정체불명 500. 여기서 고정하려는 계약은 세 가지다:
 *   1. 확인 불가일 때 **절대 통과시키지 않는다**(200/스트림 개시 금지).
 *   2. 확인 불가를 **404(영구 없음)로 뭉개지 않는다** — 503(재시도 가능)으로 구분한다.
 *   3. 미소유/미존재는 그대로 404(존재 사실 비노출).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ getEvent: vi.fn(), publish: vi.fn(), subscribe: vi.fn() }));

vi.mock("@/lib/v2/commerce-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/v2/commerce-client")>();
  return { ...actual, getEvent: h.getEvent };
});
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
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (handler: unknown) => handler,
  SEAT_RATE_LIMITS: { collab: {} },
}));
vi.mock("@/lib/builder/collab-presence", () => ({
  publishPresence: h.publish,
  subscribePresence: (...a: unknown[]) => {
    h.subscribe(...a);
    return () => {};
  },
}));

import { V2CommerceError } from "@/lib/v2/commerce-client";

import { GET, POST } from "./route";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const MAP_ID = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ eventId: EVENT_ID, mapId: MAP_ID }) };

// 라우트 시그니처는 NextRequest 를 요구하지만 이 테스트가 쓰는 건 url/method/body 뿐이다.
function getRequest(): NextRequest {
  return new Request("http://localhost/collab") as unknown as NextRequest;
}
function postRequest(): NextRequest {
  return new Request("http://localhost/collab", {
    method: "POST",
    body: JSON.stringify({ type: "cursor", x: 1, y: 2 }),
  }) as unknown as NextRequest;
}

afterEach(() => {
  h.getEvent.mockReset();
  h.publish.mockReset();
  h.subscribe.mockReset();
});

describe("collab presence — 소유 확인 불가(v2 장애)", () => {
  it("🔴 GET: 확인 불가를 '확인됨'으로 바꾸지 않는다 — 스트림을 열지 않고 503", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    const res = await GET(getRequest(), ctx);
    expect(res.status).toBe(503);
    // 스트림이 열렸다면 join 이 브로드캐스트된다 → 미검증 접근이 성사됐다는 증거.
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Type")).not.toBe("text/event-stream");
  });

  it("🔴 GET: 확인 불가를 404(영구 없음)로 뭉개지 않는다", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("timeout", 504));
    const res = await GET(getRequest(), ctx);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("잠시 후 다시 시도해주세요");
  });

  it("🔴 POST: 확인 불가면 presence 를 발행하지 않고 503", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("service unavailable", 503));
    const res = await POST(postRequest(), ctx);
    expect(res.status).toBe(503);
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe("collab presence — 미소유/미존재는 그대로 404", () => {
  it("v2 404(없음 또는 타 계정) → 404 (503 으로 승격하지 않는다)", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("not found", 404));
    const res = await GET(getRequest(), ctx);
    expect(res.status).toBe(404);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("소유 이벤트지만 맵이 v2 payload 에 없음 → 404", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID,
      content: { seat_map_data: { maps: [{ id: "33333333-3333-4333-8333-333333333333" }] } },
    });
    const res = await POST(postRequest(), ctx);
    expect(res.status).toBe(404);
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe("collab presence — 정상 경로 회귀", () => {
  it("소유 + 맵 존재 → POST 발행 성공(200)", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID,
      content: { seat_map_data: { maps: [{ id: MAP_ID }] } },
    });
    const res = await POST(postRequest(), ctx);
    expect(res.status).toBe(200);
    expect(h.publish).toHaveBeenCalledTimes(1);
    // 테넌트 경계가 v2 로 전달됐는지(빠지면 크로스테넌트 접근).
    expect(h.getEvent).toHaveBeenCalledWith(EVENT_ID, { organizerRef: "acc-1" });
  });

  it("소유 + 맵 존재 → GET 은 SSE 스트림(200)", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVENT_ID,
      content: { seat_map_data: { maps: [{ id: MAP_ID }] } },
    });
    const res = await GET(getRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    await res.body?.cancel();
  });
});

/**
 * 레벨2 T2-EVT — 커머스 재동기화 라우트의 v2 응답불가 처리 회귀.
 *
 * `resyncEventCommerce` 는 소유 검증에 `resolveOwnedV2EventId` 를 쓰므로 v2 장애 시
 * `EventAccessError` 를 던진다. 이 라우트의 폴백은 `err instanceof Error → 400 + err.message` 라,
 * 잡지 않으면 **일시 장애가 400(요청 오류)** 으로 보이고 내부 문구가 그대로 노출된다.
 * 재동기화는 "누락 복구" 버튼이라 400 을 받으면 주최자가 재시도를 포기한다 → 503 으로 분리.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ getEvent: vi.fn(), upsertTiers: vi.fn(), query: vi.fn() }));

vi.mock("@/lib/v2/commerce-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/v2/commerce-client")>();
  return { ...actual, getEvent: h.getEvent, upsertTiers: h.upsertTiers };
});
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));
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

import { POST } from "./route";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ eventId: EVENT_ID }) };
// 라우트 시그니처는 NextRequest 를 요구하지만 이 테스트가 쓰는 건 method 뿐이다.
const request = () =>
  new Request("http://localhost/resync-commerce", { method: "POST" }) as unknown as NextRequest;

afterEach(() => {
  h.getEvent.mockReset();
  h.upsertTiers.mockReset();
  h.query.mockReset();
});

describe("POST /resync-commerce", () => {
  it("🔴 v2 응답불가 → 503, 티어를 쓰지 않는다(fail-closed)", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("bad gateway", 502));
    const res = await POST(request(), ctx);
    expect(res.status).toBe(503);
    expect(h.upsertTiers).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain("잠시 후 다시 시도해주세요");
  });

  it("v2 404(없음/타 계정) → 400 '이벤트를 찾을 수 없습니다' (기존 계약 유지)", async () => {
    h.getEvent.mockRejectedValue(new V2CommerceError("not found", 404));
    const res = await POST(request(), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("이벤트를 찾을 수 없습니다");
  });
});

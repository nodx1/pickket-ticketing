/**
 * 공개 공지 라우트(목록/생성/수정/삭제) — 레벨2 컷오버 **W5-CONTENT** 회귀.
 *
 * go `open_notices` → v2 `organizer_open_notices`. 고정하는 계약:
 *   ① go DB 미사용
 *   ② 테넌트 경계 — v2 호출에 organizer_ref 가 실린다
 *   ③ 생성은 호출측이 만든 item_id 로 멱등(네트워크 재시도에 중복 공지 없음)
 *   ④ 🔴 목록 실패를 **빈 배열로 폴백하지 않는다**(주최자가 "공지가 다 사라졌다"로 오독)
 *   ⑤ 🔴 DELETE 를 "이미 없음 → 200 deleted" 로 흡수하지 않는다(v2 장애 → 503)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };
vi.mock("@/lib/auth/withAuth", () => ({
  withAuth:
    (handler: (req: NextRequest, ctx: unknown) => Promise<Response>) =>
    (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) =>
      handler(req, { session: stubSession, params: ctx.params }),
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

const { getPool, poolQuery } = vi.hoisted(() => {
  const poolQuery = vi.fn();
  return { getPool: vi.fn(() => ({ query: poolQuery })), poolQuery };
});
vi.mock("@/lib/db/pool", () => ({ getPool }));

const h = vi.hoisted(() => {
  class V2CommerceError extends Error {
    constructor(message: string, readonly status: number, readonly body?: string) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    listOrganizerNotices: vi.fn(),
    createOrganizerNotice: vi.fn(),
    patchOrganizerNotice: vi.fn(),
    deleteOrganizerNotice: vi.fn(),
    V2CommerceError,
  };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  listOrganizerNotices: h.listOrganizerNotices,
  createOrganizerNotice: h.createOrganizerNotice,
  patchOrganizerNotice: h.patchOrganizerNotice,
  deleteOrganizerNotice: h.deleteOrganizerNotice,
  V2CommerceError: h.V2CommerceError,
}));

import { GET, POST } from "@/app/api/events/[eventId]/open-notices/route";
import { PATCH, DELETE } from "@/app/api/events/[eventId]/open-notices/[noticeId]/route";

function req(body: unknown): NextRequest {
  return { json: async () => body, headers: new Headers() } as unknown as NextRequest;
}
const listCtx = { params: Promise.resolve({ eventId: "event-1" }) };
const itemCtx = { params: Promise.resolve({ eventId: "event-1", noticeId: "n-1" }) };

function v2Notice(over: Record<string, unknown> = {}) {
  return {
    id: "n-1",
    event_id: "event-1",
    notice_type: "general",
    title: "공지",
    content: "본문",
    is_published: false,
    published_at: null,
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  poolQuery.mockReset();
  h.listOrganizerNotices.mockReset();
  h.createOrganizerNotice.mockReset();
  h.patchOrganizerNotice.mockReset();
  h.deleteOrganizerNotice.mockReset();
});

describe("open-notices GET/POST — W5-CONTENT", () => {
  it("목록: v2 행을 화면 계약(type/isPublished/publishedAt)으로 매핑하고 go DB 를 쓰지 않는다", async () => {
    h.listOrganizerNotices.mockResolvedValue({
      notices: [v2Notice({ notice_type: "refund", is_published: true, published_at: "2026-07-27T01:00:00Z" })],
    });
    const res = await GET(req({}), listCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toEqual({
      id: "n-1", type: "refund", title: "공지", content: "본문",
      isPublished: true, publishedAt: "2026-07-27T01:00:00Z", createdAt: "2026-07-27T00:00:00Z",
    });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(h.listOrganizerNotices).toHaveBeenCalledWith("event-1", "acct-1");
  });

  it("🔴 목록의 v2 장애는 503 — 빈 배열(=공지 0건)로 폴백하지 않는다", async () => {
    h.listOrganizerNotices.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await GET(req({}), listCtx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; data?: unknown };
    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
  });

  it("미소유 이벤트(v2 404)는 404", async () => {
    h.listOrganizerNotices.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await GET(req({}), listCtx)).status).toBe(404);
  });

  it("생성: 입력검증(제목/내용/유형)은 400, v2 호출 없음", async () => {
    expect((await POST(req({ type: "general", title: "", content: "c" }), listCtx)).status).toBe(400);
    expect((await POST(req({ type: "hack", title: "t", content: "c" }), listCtx)).status).toBe(400);
    expect(h.createOrganizerNotice).not.toHaveBeenCalled();
  });

  it("생성: 호출측이 만든 item_id(UUID)로 멱등 생성한다", async () => {
    h.createOrganizerNotice.mockResolvedValue(v2Notice({ is_published: true }));
    const res = await POST(
      req({ type: "general", title: "t", content: "c", isPublished: true }), listCtx,
    );
    expect(res.status).toBe(200);
    const [eventId, organizerRef, itemId, input] = h.createOrganizerNotice.mock.calls[0]!;
    expect(eventId).toBe("event-1");
    expect(organizerRef).toBe("acct-1");
    expect(String(itemId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(input).toEqual({
      notice_type: "general", title: "t", content: "c", is_published: true,
    });
  });

  it("🔴 생성의 v2 장애는 503(400 아님)", async () => {
    h.createOrganizerNotice.mockRejectedValue(new h.V2CommerceError("boom", 0));
    const res = await POST(req({ type: "general", title: "t", content: "c" }), listCtx);
    expect(res.status).toBe(503);
  });
});

describe("open-notices PATCH/DELETE — W5-CONTENT", () => {
  it("수정: 전달된 키만 patch 한다(미전달 필드는 v2 보존)", async () => {
    h.patchOrganizerNotice.mockResolvedValue(v2Notice({ is_published: true }));
    const res = await PATCH(req({ isPublished: true }), itemCtx);
    expect(res.status).toBe(200);
    expect(h.patchOrganizerNotice).toHaveBeenCalledWith("event-1", "acct-1", "n-1", {
      is_published: true,
    });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("수정: 잘못된 유형은 400", async () => {
    expect((await PATCH(req({ type: "hack" }), itemCtx)).status).toBe(400);
    expect(h.patchOrganizerNotice).not.toHaveBeenCalled();
  });

  it("삭제: 정상은 200, 이미 없는 공지(v2 404)는 404", async () => {
    h.deleteOrganizerNotice.mockResolvedValue({ deleted: true, id: "n-1" });
    expect((await DELETE(req({}), itemCtx)).status).toBe(200);
    h.deleteOrganizerNotice.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await DELETE(req({}), itemCtx)).status).toBe(404);
  });

  it("🔴 삭제의 v2 장애는 503 — '지웠다(200)'로 흡수하지 않는다", async () => {
    h.deleteOrganizerNotice.mockRejectedValue(new h.V2CommerceError("boom", 503));
    const res = await DELETE(req({}), itemCtx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });
});

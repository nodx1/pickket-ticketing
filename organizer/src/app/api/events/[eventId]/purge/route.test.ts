import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * 이벤트 영구삭제 — 레벨2 컷오버 W2-EVT 회귀.
 *
 * 핵심 관심사: **"지우지 않은 것을 지웠다고 응답하지 않는다"**.
 * v2 장애(5xx/네트워크)를 "이미 삭제됨"으로 흡수하면 주최자가 삭제됐다고 믿게 된다.
 */
const h = vi.hoisted(() => {
  class V2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { getEvent: vi.fn(), deleteEvent: vi.fn(), V2CommerceError };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1" },
      }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  getEvent: h.getEvent,
  getEventBySlug: vi.fn(),
  deleteEvent: h.deleteEvent,
  V2CommerceError: h.V2CommerceError,
}));

import { DELETE } from "@/app/api/events/[eventId]/purge/route";

function call() {
  return DELETE(
    new Request("http://localhost/api/events/event-1/purge", {
      method: "DELETE",
    }) as unknown as NextRequest,
    { params: Promise.resolve({ eventId: "event-1" }) },
  );
}

describe("event purge (W2-EVT)", () => {
  beforeEach(() => {
    h.getEvent.mockReset().mockResolvedValue({ event_id: "event-1", status: "archived" });
    h.deleteEvent.mockReset().mockResolvedValue({ deleted: true, event_id: "event-1" });
  });

  it("보관된 이벤트를 v2 하드삭제한다 (go DB 조회 없음)", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, data: { deleted: true } });
    // 🔴 테넌트 경계: v2 read 에 organizer_ref 가 반드시 실려야 한다.
    expect(h.getEvent).toHaveBeenCalledWith("event-1", { organizerRef: "account-1" });
    expect(h.deleteEvent).toHaveBeenCalledWith("event-1", "account-1");
  });

  it("타 계정 이벤트(v2 404)는 404 — 삭제 시도조차 하지 않는다", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("not found", 404));
    const res = await call();
    expect(res.status).toBe(404);
    expect(h.deleteEvent).not.toHaveBeenCalled();
  });

  it("보관 상태가 아니면 400", async () => {
    h.getEvent.mockResolvedValue({ event_id: "event-1", status: "live" });
    const res = await call();
    expect(res.status).toBe(400);
    expect(h.deleteEvent).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애(5xx)는 503 — '이미 삭제됨'으로 흡수하지 않는다", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 502));
    const res = await call();
    expect(res.status).toBe(503);
    expect(h.deleteEvent).not.toHaveBeenCalled();
  });

  it("🔴 삭제 호출이 5xx 로 실패하면 503 (deleted:true 금지)", async () => {
    h.deleteEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  it("주문이 남아 있으면 409", async () => {
    h.deleteEvent.mockRejectedValue(new h.V2CommerceError("EVENT_HAS_ORDERS", 409));
    expect((await call()).status).toBe(409);
  });

  it("조회 후 경합 삭제(404)는 멱등 성공으로 흡수", async () => {
    h.deleteEvent.mockRejectedValue(new h.V2CommerceError("gone", 404));
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { deleted: true } });
  });
});

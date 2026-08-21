import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W2-PUB 공개 이벤트 해석기 회귀.
 *
 * wave1 에서 실제로 터진 결함들을 고정한다:
 *  ① v2 장애를 404 로 강등하지 않는다 → **503**(재시도 신호).
 *  ② 상태 게이트를 잃지 않는다 → draft/paused 는 404 로 차단.
 *  ③ read 가 write 를 일으키지 않는다 → 조회 실패 시 이벤트 생성 호출 없음.
 */
const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getEvent: vi.fn(),
    getEventBySlug: vi.fn(),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  getEvent: h.getEvent,
  getEventBySlug: h.getEventBySlug,
}));

import {
  PUBLIC_ANY_STATUS,
  PUBLIC_LIVE_OR_PAUSED_STATUSES,
  PUBLIC_LIVE_STATUSES,
  PUBLIC_PURCHASE_STATUSES,
  resolvePublicEventById,
  resolvePublicEventBySlug,
} from "@/lib/v2/public-event";

function event(status: string) {
  return { event_id: "evt-1", slug: "my-event", status, title: "T" };
}

beforeEach(() => {
  h.getEvent.mockReset();
  h.getEventBySlug.mockReset();
});

describe("resolvePublicEventBySlug", () => {
  it("live 이벤트를 통과시킨다", async () => {
    h.getEventBySlug.mockResolvedValue(event("live"));
    const r = await resolvePublicEventBySlug("my-event", PUBLIC_LIVE_STATUSES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.event_id).toBe("evt-1");
  });

  it("미존재 slug 는 404", async () => {
    h.getEventBySlug.mockRejectedValue(new h.MockV2CommerceError("nope", 404));
    const r = await resolvePublicEventBySlug("ghost", PUBLIC_LIVE_STATUSES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("🔴 v2 장애는 404 가 아니라 503 (빈 화면 위장 금지)", async () => {
    h.getEventBySlug.mockRejectedValue(new h.MockV2CommerceError("boom", 500));
    const r = await resolvePublicEventBySlug("my-event", PUBLIC_LIVE_STATUSES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.reason).toBe("unavailable");
    }
  });

  it("🔴 상태 게이트 — draft 는 공개 경로에서 404", async () => {
    h.getEventBySlug.mockResolvedValue(event("draft"));
    const r = await resolvePublicEventBySlug("my-event", PUBLIC_LIVE_STATUSES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("🔴 상태 게이트 — paused 는 판매 경로에서 차단, 문의 경로에서는 통과", async () => {
    h.getEventBySlug.mockResolvedValue(event("paused"));
    const purchase = await resolvePublicEventBySlug("my-event", PUBLIC_PURCHASE_STATUSES);
    expect(purchase.ok).toBe(false);

    h.getEventBySlug.mockResolvedValue(event("paused"));
    const inquiry = await resolvePublicEventBySlug("my-event", PUBLIC_LIVE_OR_PAUSED_STATUSES);
    expect(inquiry.ok).toBe(true);
  });

  it("soldout 은 판매 경로 허용목록에 남아 있다(옛 게이트 동일성)", async () => {
    h.getEventBySlug.mockResolvedValue(event("soldout"));
    const r = await resolvePublicEventBySlug("my-event", PUBLIC_PURCHASE_STATUSES);
    expect(r.ok).toBe(true);
  });

  it("read 가 write 를 유발하지 않는다 — 조회만 호출된다", async () => {
    h.getEventBySlug.mockResolvedValue(event("live"));
    await resolvePublicEventBySlug("my-event", PUBLIC_LIVE_STATUSES);
    expect(h.getEventBySlug).toHaveBeenCalledTimes(1);
    expect(h.getEvent).not.toHaveBeenCalled();
  });
});

describe("resolvePublicEventById", () => {
  it("id 를 그대로 v2 에 넘긴다(앵커 변환 없음)", async () => {
    h.getEvent.mockResolvedValue(event("live"));
    const r = await resolvePublicEventById("evt-1", PUBLIC_ANY_STATUS);
    expect(r.ok).toBe(true);
    expect(h.getEvent).toHaveBeenCalledWith("evt-1");
  });

  it("404/4xx 는 미존재, 5xx 는 503", async () => {
    h.getEvent.mockRejectedValue(new h.MockV2CommerceError("nope", 404));
    const notFound = await resolvePublicEventById("evt-1", PUBLIC_ANY_STATUS);
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.status).toBe(404);

    h.getEvent.mockRejectedValue(new h.MockV2CommerceError("bad", 422));
    const badRequest = await resolvePublicEventById("evt-1", PUBLIC_ANY_STATUS);
    if (!badRequest.ok) expect(badRequest.status).toBe(404);

    h.getEvent.mockRejectedValue(new h.MockV2CommerceError("down", 0));
    const down = await resolvePublicEventById("evt-1", PUBLIC_ANY_STATUS);
    if (!down.ok) expect(down.status).toBe(503);
  });

  it("상태 게이트를 id 경로에서도 적용한다", async () => {
    h.getEvent.mockResolvedValue(event("archived"));
    const r = await resolvePublicEventById("evt-1", PUBLIC_LIVE_STATUSES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });
});

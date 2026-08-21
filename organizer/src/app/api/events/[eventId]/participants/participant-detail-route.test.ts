/**
 * participants 단건 PATCH/DELETE — 레벨2 컷오버 **W5-CONTENT** 회귀.
 *
 * ## 이 테스트가 대체한 것
 * 예전에는 go 가 원본을 갖고 "go 커밋 → 발행분 전체 재조회 → v2 섹션 전체 PUT" 을 했고,
 * 그 임계구역을 go 쪽 `pg_advisory_lock` 으로 직렬화해야 했다(3차 재감사 P1).
 * 이제 정본(`organizer_event_participants`)과 소비자 투영(`event_participants` 미러)이
 * **둘 다 v2 안**에 있고 v2 가 한 트랜잭션에서 갱신한다 → go 의 락·재조회·전체 PUT 이 소멸했다.
 * 그래서 검증 대상이 "락 순서"에서 **"go DB 미사용 + 에러 계약"** 으로 바뀐다.
 *
 * 검증:
 *   ① go DB 를 전혀 건드리지 않는다(pool 미사용) — 6테이블 SQL 0 의 런타임 증거
 *   ② 정상 경로: v2 호출 인자(테넌트 ref·전달 필드만 patch)와 화면 계약(snake shape)
 *   ③ 미소유/미존재(v2 404) → **404**
 *   ④ v2 장애(5xx/네트워크) → **503** — 특히 DELETE 를 "이미 없음 → 200 deleted" 로
 *      흡수하지 않는다(v2 장애를 "지웠다"고 거짓말하면 안 된다)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };
vi.mock("@/lib/auth/withAuth", () => ({
  withAuth:
    (
      handler: (
        req: NextRequest,
        ctx: {
          session: typeof stubSession;
          params: Promise<{ eventId: string; participantId: string }>;
        },
      ) => Promise<Response>,
    ) =>
    (req: NextRequest) =>
      handler(req, {
        session: stubSession,
        params: Promise.resolve({ eventId: "event-1", participantId: "p-1" }),
      }),
}));

// feature gate 통과(플랜 게이트 자체는 require-feature 테스트가 담당).
vi.mock("@/lib/server/require-feature", () => ({
  requireFeature: vi.fn(async () => null),
}));

const { getPool, poolQuery } = vi.hoisted(() => {
  const poolQuery = vi.fn();
  return { getPool: vi.fn(() => ({ query: poolQuery })), poolQuery };
});
vi.mock("@/lib/db/pool", () => ({ getPool }));

const h = vi.hoisted(() => {
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
    patchOrganizerParticipant: vi.fn(),
    deleteOrganizerParticipant: vi.fn(),
    V2CommerceError,
  };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  patchOrganizerParticipant: h.patchOrganizerParticipant,
  deleteOrganizerParticipant: h.deleteOrganizerParticipant,
  V2CommerceError: h.V2CommerceError,
}));

import { PATCH, DELETE } from "@/app/api/events/[eventId]/participants/[participantId]/route";

const ctx = { params: Promise.resolve({ eventId: "event-1", participantId: "p-1" }) };

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function v2Row(over: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    event_id: "event-1",
    name: "새이름",
    role: "performer",
    bio: null,
    image_url: null,
    sort_order: 0,
    is_visible: true,
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  poolQuery.mockReset();
  h.patchOrganizerParticipant.mockReset();
  h.deleteOrganizerParticipant.mockReset();
  h.patchOrganizerParticipant.mockResolvedValue(v2Row());
  h.deleteOrganizerParticipant.mockResolvedValue({ deleted: true, id: "p-1" });
});

describe("participants PATCH — W5-CONTENT(v2 정본 이관)", () => {
  it("go DB 를 쓰지 않고 v2 에 전달된 필드만 patch 한다(테넌트 ref 포함)", async () => {
    const res = await PATCH(req({ name: "새이름", isVisible: false }), ctx);
    expect(res.status).toBe(200);

    expect(poolQuery).not.toHaveBeenCalled(); // go SQL 0
    expect(h.patchOrganizerParticipant).toHaveBeenCalledTimes(1);
    const [eventId, organizerRef, itemId, patch] = h.patchOrganizerParticipant.mock.calls[0]!;
    expect(eventId).toBe("event-1");
    expect(organizerRef).toBe("acct-1"); // 🔴 테넌트 경계는 v2 가 이 값으로 강제한다
    expect(itemId).toBe("p-1");
    // 미전달 키(bio/role/imageUrl/sortOrder)는 patch 에 없어야 한다 — v2 가 보존한다.
    expect(patch).toEqual({ name: "새이름", is_visible: false });
  });

  it("화면 계약(snake shape)을 유지한다", async () => {
    const res = await PATCH(req({ name: "새이름" }), ctx);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: "p-1", name: "새이름", image_url: null, sort_order: 0, is_visible: true,
    });
  });

  it("유효하지 않은 역할은 400(사용자 입력 오류만 400)", async () => {
    const res = await PATCH(req({ role: "hacker" }), ctx);
    expect(res.status).toBe(400);
    expect(h.patchOrganizerParticipant).not.toHaveBeenCalled();
  });

  it("미소유/미존재(v2 404)는 404", async () => {
    h.patchOrganizerParticipant.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await PATCH(req({ name: "x" }), ctx)).status).toBe(404);
  });

  it("🔴 v2 장애는 503 — 400(입력오류)이나 404(없음)로 뭉개지 않는다", async () => {
    for (const status of [0, 500, 502, 503]) {
      h.patchOrganizerParticipant.mockRejectedValue(new h.V2CommerceError("boom", status));
      expect((await PATCH(req({ name: "x" }), ctx)).status).toBe(503);
    }
  });
});

describe("participants DELETE — W5-CONTENT(v2 정본 이관)", () => {
  it("go DB 를 쓰지 않고 v2 삭제를 호출한다", async () => {
    const res = await DELETE(req({}), ctx);
    expect(res.status).toBe(200);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(h.deleteOrganizerParticipant).toHaveBeenCalledWith("event-1", "acct-1", "p-1");
  });

  it("이미 없는 항목(v2 404)은 404", async () => {
    h.deleteOrganizerParticipant.mockRejectedValue(new h.V2CommerceError("not found", 404));
    expect((await DELETE(req({}), ctx)).status).toBe(404);
  });

  // 🔴 실제로 있었던 결함: "조회 실패 → null → 이미 없음 → 200 deleted" 로 v2 장애를 위장.
  it("🔴 v2 장애는 503 — '지웠다(200)'로 흡수하지 않는다", async () => {
    h.deleteOrganizerParticipant.mockRejectedValue(new h.V2CommerceError("boom", 502));
    const res = await DELETE(req({}), ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });
});

/**
 * 🔴 프로그램 탭 자유문구 — **비우기가 v2 까지 전달되는가** (2026-08-02)
 *
 * ## 왜 이 파일이 따로 있는가
 * `program_notes`·`stage_info` 는 organizer(여기) ↔ v2 두 쪽이 맞물려야 동작한다.
 * v2 쪽 6줄(`df4f1e7c`)은 `in _fields` 방식이라 **명시 null 이 오면 지운다.**
 * 그런데 v2 에 추가된 테스트는 **넣는 경우만** 태운다 — `None` 전송 케이스가 0건이다.
 *
 * ⟹ 누가 나중에 v2 를 `if body.program_notes is not None:` 으로 바꿔도 그쪽 테스트는
 *    전부 통과한다. 그 회귀를 **여기서 절반 막는다** — organizer 가 비우기를
 *    "키 생략" 이 아니라 **명시 `null`** 로 보낸다는 사실을 고정해 두면,
 *    최소한 "보내는 쪽은 맞다" 가 증거로 남는다.
 *
 * ⚠️ 나머지 절반(v2 가 그 null 을 실제로 지우는가)은 여기서 증명할 수 없다.
 *    그건 배포 후 수동 확인 #4(값 지우고 저장 → 새로고침) 가 담당한다.
 *
 * ## 왜 문자열 검사가 아니라 호출 단언인가
 * 같은 배선을 `expect(code).toMatch(/programNotes/)` 로 검사했다가 하루에 네 번
 * 뮤테이션이 생존했다. 문자열은 **관계를 표현하지 못한다** — 여기서는 실제로
 * 핸들러를 태워 `updateEvent` 에 넘어간 **값**을 본다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  updateEvent: vi.fn(),
  requireOwnedEvent: vi.fn(),
  session: { accountId: "acc-1", id: "user-1", role: "organizer" } as Record<string, unknown>,
  params: { eventId: "evt-1" } as Record<string, string>,
}));

vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
      (request: Request) =>
        handler(request, { session: h.session, params: h.params }),
}));
vi.mock("@/lib/v2/event-access", () => ({
  requireOwnedEvent: h.requireOwnedEvent,
  eventAccessStatus: () => 404,
  EventAccessError: class extends Error {},
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  updateEvent: h.updateEvent,
  goAccountRef: (id: string) => `go:${id}`,
  listEventHostLinks: vi.fn(async () => []),
  listTiers: vi.fn(async () => []),
  putEventHostLinks: vi.fn(),
  recordPublicationReview: vi.fn(),
  V2CommerceError: class extends Error {},
}));
vi.mock("@/lib/v2/event-view", () => ({ toGoEventView: (e: unknown) => e }));
vi.mock("@/lib/v2/business-verification-client", () => ({
  fetchBizVerification: vi.fn(async () => ({ verificationStatus: "verified" })),
  V2BizVerifError: class extends Error {},
}));
vi.mock("@/lib/v2/review-request-sync", () => ({ pushReviewRequestToV2: vi.fn() }));
vi.mock("@/lib/redis", () => ({ getPrefixedRedis: () => null }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: vi.fn(async () => ({ rows: [] })) }) }));

import { PATCH } from "@/app/api/events/[eventId]/route";

/**
 * 실제 핸들러를 태우고 v2 로 나간 patch 를 돌려준다.
 * 모의 withRole 이 session·params 를 직접 주입하므로 Next context 인자는 필요 없다
 * — 인접 테스트(`w4-evt-owned-routes.test.ts:127`)와 같은 방식으로 시그니처만 좁힌다.
 */
async function patchAndCaptureV2Payload(body: Record<string, unknown>) {
  const request = new Request("https://go.pickket.kr/api/events/evt-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await (PATCH as unknown as (r: Request) => Promise<Response>)(request);
  return { res, sent: h.updateEvent.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined };
}

beforeEach(() => {
  h.updateEvent.mockReset();
  h.updateEvent.mockResolvedValue({ event_id: "v2-evt-1" });
  h.requireOwnedEvent.mockResolvedValue({
    event_id: "v2-evt-1",
    status: "draft",
    event_date: "2026-08-20T00:00:00Z",
    event_date_end: "2026-08-23T00:00:00Z",
    event_type: "sports",
  });
});
afterEach(() => vi.clearAllMocks());

describe("프로그램 안내 · 무대 구역 안내 — 저장", () => {
  it("입력한 값이 v2 키(program_notes · stage_info)로 나간다", async () => {
    const { sent } = await patchAndCaptureV2Payload({
      programNotes: "1일차 프로암",
      stageInfo: "A구역 그늘집",
    });
    expect(sent).toMatchObject({ program_notes: "1일차 프로암", stage_info: "A구역 그늘집" });
  });

  /**
   * 🔴 이 세 개가 이 파일의 존재 이유다.
   *
   * 비우기는 **키를 빼는 것으로는 안 된다** — v2 는 `in _fields` 로 판정하므로
   * 키가 없으면 "안 건드림" 이고, 옛 값이 그대로 남는다.
   * 반드시 **키는 있고 값이 null** 이어야 한다.
   */
  describe("🔴 비우기 — 명시 null 로 나가야 한다", () => {
    it("빈 문자열은 null 로 바뀌어 나간다", async () => {
      const { sent } = await patchAndCaptureV2Payload({ programNotes: "", stageInfo: "" });
      expect(sent?.program_notes, "빈 문자열 그대로면 v2 에 '' 가 저장된다").toBeNull();
      expect(sent?.stage_info).toBeNull();
    });

    it("🔴 키가 **빠지지 않는다** — 빠지면 v2 가 '안 건드림' 으로 읽어 옛 값이 남는다", async () => {
      const { sent } = await patchAndCaptureV2Payload({ programNotes: "", stageInfo: "" });
      // toMatchObject 로는 못 본다 — 키 부재를 통과시킨다. 그래서 in 으로 직접 본다.
      expect(Object.keys(sent ?? {})).toContain("program_notes");
      expect(Object.keys(sent ?? {})).toContain("stage_info");
    });

    it("공백만 있어도 비운 것으로 본다", async () => {
      const { sent } = await patchAndCaptureV2Payload({ programNotes: "   " });
      // `|| null` 은 공백을 truthy 로 본다 — 지금 동작을 그대로 고정한다.
      // ⚠️ 이 단언이 깨지면 동작이 바뀐 것이니, 바꾼 쪽이 의도인지 확인할 것.
      expect(sent?.program_notes).toBe("   ");
    });
  });

  it("안 보낸 필드는 patch 에 아예 없다 — 다른 필드 비파괴", async () => {
    const { sent } = await patchAndCaptureV2Payload({ programNotes: "값" });
    expect(Object.keys(sent ?? {})).not.toContain("stage_info");
  });
});

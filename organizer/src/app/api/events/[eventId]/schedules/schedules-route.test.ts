/**
 * `/api/events/[eventId]/schedules` — 레벨2 컷오버 W2-EVT 회귀.
 *
 * go `event_schedules` 테이블 → v2 `events.event_schedules`(JSONB) 이관.
 * 관심사: (1) go 확장 필드(id/ends_at/venue_name/sort_order) 왕복 무손실,
 *        (2) 미소유/장애 구분, (3) PATCH 가 없는 일정에 200 을 주지 않을 것.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  class V2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { getEvent: vi.fn(), updateEvent: vi.fn(), V2CommerceError };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { accountId: "account-1", role: "organizer" },
        params: { eventId: "event-1", scheduleId: "s1" },
      }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  getEvent: h.getEvent,
  getEventBySlug: vi.fn(),
  updateEvent: h.updateEvent,
  goAccountRef: (accountId: string) => ({ go_account_id: accountId }),
  V2CommerceError: h.V2CommerceError,
}));

import { GET, POST } from "@/app/api/events/[eventId]/schedules/route";
import { PATCH, DELETE } from "@/app/api/events/[eventId]/schedules/[scheduleId]/route";

function eventWith(schedules: unknown[]) {
  return { event_id: "event-1", status: "draft", content: { event_schedules: schedules } };
}

const stored = [
  {
    id: "s1",
    time: "2026-09-01T18:00:00.000Z",
    title: "1부",
    description: "오프닝",
    ends_at: "2026-09-01T19:00:00.000Z",
    venue_name: "메인홀",
    sort_order: 0,
  },
];

const listCtx = { params: Promise.resolve({ eventId: "event-1" }) };
const itemCtx = { params: Promise.resolve({ eventId: "event-1", scheduleId: "s1" }) };

function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/events/event-1/schedules", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

/** updateEvent 로 전달된 event_schedules 배열. */
function sentSchedules() {
  const patch = h.updateEvent.mock.calls[0]?.[1] as { event_schedules?: unknown[] };
  return patch?.event_schedules ?? [];
}

beforeEach(() => {
  h.getEvent.mockReset().mockResolvedValue(eventWith(stored));
  h.updateEvent.mockReset().mockResolvedValue({ event_id: "event-1" });
});

describe("GET (타임테이블 목록)", () => {
  it("v2 JSONB 를 go UI 형태로 복원한다(확장 필드 포함)", async () => {
    const res = await GET(req("GET"), listCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      {
        id: "s1",
        title: "1부",
        description: "오프닝",
        startsAt: "2026-09-01T18:00:00.000Z",
        endsAt: "2026-09-01T19:00:00.000Z",
        venueName: "메인홀",
        sortOrder: 0,
        // 저장된 값에 `image_url` 이 없으면 **없음**으로 복원한다(키 누락 ≠ 오류).
        imageUrl: null,
      },
    ]);
    expect(h.getEvent).toHaveBeenCalledWith("event-1", { organizerRef: "account-1" });
  });

  it("🔴 타 계정 이벤트는 404 — 옛 코드처럼 빈 목록을 주지 않는다", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect((await GET(req("GET"), listCtx)).status).toBe(404);
  });

  it("🔴 v2 장애는 503", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect((await GET(req("GET"), listCtx)).status).toBe(503);
  });
});

describe("POST (추가)", () => {
  const body = {
    title: "2부",
    description: "본공연",
    startsAt: "2026-09-01T20:00:00.000Z",
    endsAt: "2026-09-01T21:30:00.000Z",
    venueName: "메인홀",
    sortOrder: 1,
  };

  it("기존 항목을 보존한 채 추가하고 확장 키를 함께 저장한다", async () => {
    const res = await POST(req("POST", body), listCtx);
    expect(res.status).toBe(201);
    const sent = sentSchedules() as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(2);
    expect(sent[0].id).toBe("s1"); // 기존 항목 보존
    expect(sent[1]).toMatchObject({
      time: "2026-09-01T20:00:00.000Z",
      title: "2부",
      ends_at: "2026-09-01T21:30:00.000Z",
      venue_name: "메인홀",
      sort_order: 1,
    });
  });

  it("🔴 타 계정 이벤트는 404 — write 없음", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect((await POST(req("POST", body), listCtx)).status).toBe(404);
    expect(h.updateEvent).not.toHaveBeenCalled();
  });

  it("🔴 v2 write 장애는 503", async () => {
    h.updateEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await POST(req("POST", body), listCtx)).status).toBe(503);
  });

  it("제목 2자 미만은 400", async () => {
    expect((await POST(req("POST", { ...body, title: "A" }), listCtx)).status).toBe(400);
  });
});

describe("PATCH (수정)", () => {
  it("보낸 키만 반영한다", async () => {
    const res = await PATCH(req("PATCH", { title: "1부(수정)" }), itemCtx);
    expect(res.status).toBe(200);
    const sent = sentSchedules() as Array<Record<string, unknown>>;
    expect(sent[0]).toMatchObject({
      title: "1부(수정)",
      description: "오프닝", // 미전송 → 보존
      venue_name: "메인홀",
    });
  });

  it("🔴 없는 일정은 404 — 옛 코드는 200(updated:true)을 냈다", async () => {
    h.getEvent.mockResolvedValue(eventWith([]));
    const res = await PATCH(req("PATCH", { title: "없음" }), itemCtx);
    expect(res.status).toBe(404);
    expect(h.updateEvent).not.toHaveBeenCalled();
  });

  it("🔴 타 계정 이벤트는 404 — write 없음", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect((await PATCH(req("PATCH", { title: "제목변경" }), itemCtx)).status).toBe(404);
    expect(h.updateEvent).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애는 503", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    expect((await PATCH(req("PATCH", { title: "제목변경" }), itemCtx)).status).toBe(503);
  });
});

describe("DELETE (삭제)", () => {
  it("해당 항목만 제거한다", async () => {
    const res = await DELETE(req("DELETE"), itemCtx);
    expect(res.status).toBe(200);
    expect(sentSchedules()).toEqual([]);
  });

  it("이미 없음이 확인되면 write 없이 멱등 성공", async () => {
    h.getEvent.mockResolvedValue(eventWith([]));
    const res = await DELETE(req("DELETE"), itemCtx);
    expect(res.status).toBe(200);
    expect(h.updateEvent).not.toHaveBeenCalled();
  });

  it("🔴 v2 장애는 503 — '이미 지워짐'으로 흡수하지 않는다", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("boom", 502));
    const res = await DELETE(req("DELETE"), itemCtx);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  it("🔴 삭제 write 가 실패하면 503 (deleted:true 금지)", async () => {
    h.updateEvent.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await DELETE(req("DELETE"), itemCtx);
    expect(res.status).toBe(503);
  });
});

/**
 * 🔴 일정 안내 이미지 (2026-08-19 대표 요청 — 조편성표를 일정에 붙인다)
 *
 * 세 가지가 서로 다르다. 라우트가 이 셋을 안 가르면 화면이 못 고친다:
 *   키 없음(undefined) → **건드리지 않는다**(다른 필드만 고치는 저장에서 이미지가 사라지면 안 된다)
 *   null              → **뗀다**
 *   URL               → 붙인다
 */
describe("안내 이미지 (image_url)", () => {
  const withImage = [{ ...stored[0], image_url: "https://cdn.pickket.kr/a.png" }];
  const body = { title: "2부", startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T21:00:00.000Z" };

  it("POST — URL 을 image_url 로 저장한다", async () => {
    const res = await POST(req("POST", { ...body, imageUrl: "https://cdn.pickket.kr/r1.png" }), listCtx);
    expect(res.status).toBe(201);
    expect((sentSchedules() as Array<Record<string, unknown>>)[1].image_url).toBe("https://cdn.pickket.kr/r1.png");
  });

  it("POST — 이미지 없이 만들면 image_url 은 null", async () => {
    await POST(req("POST", body), listCtx);
    expect((sentSchedules() as Array<Record<string, unknown>>)[1].image_url).toBeNull();
  });

  it("🔴 POST — URL 이 아니면 400 (화면이 빈 문자열을 그대로 보내면 여기서 걸린다)", async () => {
    expect((await POST(req("POST", { ...body, imageUrl: "" }), listCtx)).status).toBe(400);
    expect((await POST(req("POST", { ...body, imageUrl: "그냥글자" }), listCtx)).status).toBe(400);
    expect(h.updateEvent).not.toHaveBeenCalled();
  });

  it("PATCH — null 을 보내면 뗀다", async () => {
    h.getEvent.mockResolvedValue(eventWith(withImage));
    const res = await PATCH(req("PATCH", { imageUrl: null }), itemCtx);
    expect(res.status).toBe(200);
    const sent = (sentSchedules() as Array<Record<string, unknown>>)[0];
    expect(sent.image_url).toBeNull();
    expect(sent.title).toBe("1부"); // 다른 필드는 그대로
  });

  it("🔴 PATCH — 키를 안 보내면 기존 이미지가 살아 있다 (제목만 고치는 저장에서 이미지가 날아가면 안 된다)", async () => {
    h.getEvent.mockResolvedValue(eventWith(withImage));
    await PATCH(req("PATCH", { title: "1부(수정)" }), itemCtx);
    const sent = (sentSchedules() as Array<Record<string, unknown>>)[0];
    expect(sent.title).toBe("1부(수정)");
    expect(sent.image_url).toBe("https://cdn.pickket.kr/a.png");
  });

  it("PATCH — 다른 URL 로 바꾼다", async () => {
    h.getEvent.mockResolvedValue(eventWith(withImage));
    await PATCH(req("PATCH", { imageUrl: "https://cdn.pickket.kr/b.png" }), itemCtx);
    expect((sentSchedules() as Array<Record<string, unknown>>)[0].image_url).toBe("https://cdn.pickket.kr/b.png");
  });

  it("🔴 PATCH — URL 이 아니면 400, write 없음", async () => {
    expect((await PATCH(req("PATCH", { imageUrl: "그냥글자" }), itemCtx)).status).toBe(400);
    expect(h.updateEvent).not.toHaveBeenCalled();
  });

  it("GET — 저장된 image_url 을 imageUrl 로 준다", async () => {
    h.getEvent.mockResolvedValue(eventWith(withImage));
    const body2 = await (await GET(req("GET"), listCtx)).json();
    expect(body2.data[0].imageUrl).toBe("https://cdn.pickket.kr/a.png");
  });
});

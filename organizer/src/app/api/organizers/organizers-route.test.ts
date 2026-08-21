/**
 * `/api/organizers` — 레벨2 컷오버 W2-EVT 회귀.
 *
 * go `organizers` 테이블 → v2 `event_hosts` 이관. 이 라우트들은 이제 go DB 를 전혀 읽지 않고
 * 테넌트 경계도 v2 `organizer_ref` 가 강제한다.
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
  return {
    listEventHosts: vi.fn(),
    createEventHost: vi.fn(),
    getEventHost: vi.fn(),
    patchEventHost: vi.fn(),
    deleteEventHost: vi.fn(),
    V2CommerceError,
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request) =>
      handler(request, {
        session: { accountId: "account-1", role: "organizer" },
        params: { organizerId: "host-1" },
      }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  listEventHosts: h.listEventHosts,
  createEventHost: h.createEventHost,
  getEventHost: h.getEventHost,
  patchEventHost: h.patchEventHost,
  deleteEventHost: h.deleteEventHost,
  V2CommerceError: h.V2CommerceError,
}));

import { GET as LIST, POST as CREATE } from "@/app/api/organizers/route";
import {
  GET as DETAIL,
  PATCH as UPDATE,
  DELETE as REMOVE,
} from "@/app/api/organizers/[organizerId]/route";

function host(overrides: Record<string, unknown> = {}) {
  return {
    host_id: "host-1",
    name: "주최자A",
    slug: "host-a",
    description: null,
    email: null,
    phone: null,
    logo_url: null,
    contact_public: false,
    is_published: false,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const listCtx = { params: Promise.resolve({}) };
const detailCtx = { params: Promise.resolve({ organizerId: "host-1" }) };

function request(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  h.listEventHosts.mockReset().mockResolvedValue({ hosts: [host()] });
  h.createEventHost.mockReset().mockResolvedValue(host({ host_id: "host-2", slug: "host-b" }));
  h.getEventHost.mockReset().mockResolvedValue(host());
  h.patchEventHost.mockReset().mockResolvedValue(host({ name: "주최자B" }));
  h.deleteEventHost
    .mockReset()
    .mockResolvedValue({ deleted: true, needs_unlink: false, linked_event_count: 0, unlinked_event_count: 0 });
});

describe("GET /api/organizers (목록)", () => {
  it("v2 호스트를 옛 go shape 으로 반환한다", async () => {
    const res = await LIST(request("GET", "http://localhost/api/organizers"), listCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ id: "host-1", name: "주최자A", logoUrl: null });
    expect(h.listEventHosts).toHaveBeenCalledWith("account-1");
  });

  it("🔴 v2 장애는 503 — 빈 목록으로 위장하지 않는다", async () => {
    h.listEventHosts.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await LIST(request("GET", "http://localhost/api/organizers"), listCtx);
    expect(res.status).toBe(503);
  });
});

describe("POST /api/organizers (생성)", () => {
  it("slug 를 계정 스코프에서 자동 생성해 v2 로 만든다", async () => {
    const res = await CREATE(
      request("POST", "http://localhost/api/organizers", { name: "주최자B" }),
      listCtx,
    );
    expect(res.status).toBe(201);
    expect(h.createEventHost).toHaveBeenCalledWith(
      "account-1",
      expect.objectContaining({ name: "주최자B", is_published: false }),
    );
  });

  it("이름 충돌(v2 409)은 409 로 안내", async () => {
    h.createEventHost.mockRejectedValue(new h.V2CommerceError("dup", 409));
    const res = await CREATE(
      request("POST", "http://localhost/api/organizers", { name: "주최자B" }),
      listCtx,
    );
    expect(res.status).toBe(409);
  });

  it("🔴 slug 생성용 목록 조회 실패는 503 — 임의 slug 로 밀어붙이지 않는다", async () => {
    h.listEventHosts.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await CREATE(
      request("POST", "http://localhost/api/organizers", { name: "주최자B" }),
      listCtx,
    );
    expect(res.status).toBe(503);
    expect(h.createEventHost).not.toHaveBeenCalled();
  });

  it("이름 2자 미만은 400", async () => {
    const res = await CREATE(
      request("POST", "http://localhost/api/organizers", { name: "A" }),
      listCtx,
    );
    expect(res.status).toBe(400);
  });
});

describe("/api/organizers/[organizerId]", () => {
  it("상세는 organizer_ref 스코프로 조회한다", async () => {
    const res = await DETAIL(request("GET", "http://localhost/api/organizers/host-1"), detailCtx);
    expect(res.status).toBe(200);
    expect(h.getEventHost).toHaveBeenCalledWith("account-1", "host-1");
  });

  it("🔴 크로스테넌트 차단: 타 계정 host 는 404", async () => {
    h.getEventHost.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect(
      (await DETAIL(request("GET", "http://localhost/api/organizers/host-1"), detailCtx)).status,
    ).toBe(404);
  });

  it("🔴 v2 장애는 503 (404 로 뭉개면 '삭제됨' 오인)", async () => {
    h.getEventHost.mockRejectedValue(new h.V2CommerceError("boom", 502));
    expect(
      (await DETAIL(request("GET", "http://localhost/api/organizers/host-1"), detailCtx)).status,
    ).toBe(503);
  });

  it("수정은 slug 를 보내지 않는다(불변)", async () => {
    const res = await UPDATE(
      request("PATCH", "http://localhost/api/organizers/host-1", { name: "주최자B" }),
      detailCtx,
    );
    expect(res.status).toBe(200);
    const [, , patch] = h.patchEventHost.mock.calls[0];
    expect("slug" in (patch as Record<string, unknown>)).toBe(false);
  });

  it("타 계정 수정은 404", async () => {
    h.patchEventHost.mockRejectedValue(new h.V2CommerceError("nope", 404));
    expect(
      (
        await UPDATE(
          request("PATCH", "http://localhost/api/organizers/host-1", { name: "주최자B" }),
          detailCtx,
        )
      ).status,
    ).toBe(404);
  });

  it("연결 이벤트가 있으면 needsUnlink 신호를 준다(삭제하지 않음)", async () => {
    h.deleteEventHost.mockResolvedValue({
      deleted: false,
      needs_unlink: true,
      linked_event_count: 3,
      unlinked_event_count: 0,
    });
    const res = await REMOVE(
      request("DELETE", "http://localhost/api/organizers/host-1"),
      detailCtx,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { deleted: false, needsUnlink: true, linkedEventCount: 3 },
    });
    expect(h.deleteEventHost).toHaveBeenCalledWith("account-1", "host-1", false);
  });

  it("unlink=true 면 연결 해제 후 삭제", async () => {
    h.deleteEventHost.mockResolvedValue({
      deleted: true,
      needs_unlink: false,
      linked_event_count: 3,
      unlinked_event_count: 3,
    });
    const res = await REMOVE(
      request("DELETE", "http://localhost/api/organizers/host-1?unlink=true"),
      detailCtx,
    );
    await expect(res.json()).resolves.toMatchObject({
      data: { deleted: true, unlinkedEventCount: 3 },
    });
    expect(h.deleteEventHost).toHaveBeenCalledWith("account-1", "host-1", true);
  });

  it("🔴 삭제 중 v2 장애는 503 — deleted:true 로 거짓 응답하지 않는다", async () => {
    h.deleteEventHost.mockRejectedValue(new h.V2CommerceError("boom", 500));
    const res = await REMOVE(
      request("DELETE", "http://localhost/api/organizers/host-1"),
      detailCtx,
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });
});

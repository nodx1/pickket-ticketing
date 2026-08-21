import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  // 레벨2 컷오버 T2-EVT: 이벤트 앵커/소유 검증이 go events 테이블 → v2(organizer_ref)로 이동.
  class MockEventAccessError extends Error {
    constructor(
      message: string,
      readonly reason: "not_found" | "unavailable",
      readonly status: number,
    ) {
      super(message);
      this.name = "EventAccessError";
    }
  }
  return {
    query: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
    resolveOwned: vi.fn(),
    MockV2CommerceError,
    MockEventAccessError,
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: (request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request, context: { params: Promise<{ eventId: string; webhookId?: string }> }) =>
      context.params.then((params) =>
        handler(request, {
          session: { accountId: "account-1", role: "organizer" },
          params,
        }),
      ),
}));
vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({ query: h.query }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  listWebhookSubscriptions: h.list,
  createWebhookSubscription: h.create,
  getWebhookSubscription: h.get,
  patchWebhookSubscription: h.patch,
  deleteWebhookSubscription: h.remove,
  V2CommerceError: h.MockV2CommerceError,
}));
vi.mock("@/lib/v2/event-access", () => ({
  resolveOwnedV2EventId: h.resolveOwned,
  EventAccessError: h.MockEventAccessError,
}));

import { GET as listRoute, POST as createRoute } from "./route";
import {
  DELETE as deleteRoute,
  GET as detailRoute,
  PATCH as patchRoute,
} from "./[webhookId]/route";

const collectionContext = { params: Promise.resolve({ eventId: "go-event-1" }) };
const detailContext = {
  params: Promise.resolve({ eventId: "go-event-1", webhookId: "go-webhook-1" }),
};

beforeEach(() => {
  h.query.mockReset();
  h.list.mockReset();
  h.create.mockReset();
  h.get.mockReset();
  h.patch.mockReset();
  h.remove.mockReset();
  h.resolveOwned.mockReset();
  h.query.mockResolvedValue({ rows: [{ v2_event_id: "v2-event-1" }] });
  // 소유 검증 통과 = v2 canonical event id 반환(경계는 v2 organizer_ref 가 강제).
  h.resolveOwned.mockResolvedValue("v2-event-1");
});

describe("webhook route v2 flip", () => {
  it("lists v2 subscriptions without reading the go webhook tables", async () => {
    h.list.mockResolvedValue({
      webhooks: [{
        id: "go-webhook-1",
        subscription_id: "v2-webhook-1",
        external_ref: "go-webhook-1",
        name: "ERP",
        url: "https://hooks.example.com/",
        secret: "****1234",
        event_types: ["order.completed"],
        is_active: true,
        created_at: "2026-07-25T00:00:00Z",
        updated_at: "2026-07-25T00:00:00Z",
      }],
      total: 1,
    });
    const response = await listRoute(
      new Request("http://localhost/api/events/go-event-1/webhooks") as NextRequest,
      collectionContext,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data[0]).toMatchObject({
      id: "go-webhook-1",
      endpointUrl: "https://hooks.example.com/",
      signingSecret: "****1234",
    });
    expect(h.list).toHaveBeenCalledWith("v2-event-1");
    // 레벨2 컷오버 T2-EVT: go DB 를 아예 건드리지 않는다(웹훅 테이블도, events 앵커도).
    expect(h.query).not.toHaveBeenCalled();
    expect(h.resolveOwned).toHaveBeenCalledWith("go-event-1", "account-1");
  });

  it("creates only in v2 and returns the one-time secret", async () => {
    h.create.mockResolvedValue({
      id: "go-webhook-1",
      subscription_id: "v2-webhook-1",
      external_ref: "go-webhook-1",
      name: "ERP",
      url: "https://hooks.example.com/",
      secret: "whsec_once",
      event_types: ["order.completed"],
      is_active: true,
      created_at: "2026-07-25T00:00:00Z",
      updated_at: "2026-07-25T00:00:00Z",
    });
    const response = await createRoute(
      new Request("http://localhost/api/events/go-event-1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ERP",
          endpointUrl: "https://hooks.example.com/",
          subscribedEvents: ["order.completed"],
        }),
      }) as NextRequest,
      collectionContext,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: { id: "go-webhook-1", signingSecret: "whsec_once" },
    });
    expect(h.create).toHaveBeenCalledWith(
      "v2-event-1",
      expect.objectContaining({
        name: "ERP",
        url: "https://hooks.example.com/",
        event_types: ["order.completed"],
      }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^webhook-create:/) }),
    );
  });

  it("reads deliveries and mutates/deletes through v2 under the event anchor", async () => {
    h.get.mockResolvedValue({
      id: "go-webhook-1",
      name: "ERP",
      url: "https://hooks.example.com/",
      secret: "****1234",
      is_active: true,
      event_types: ["order.completed"],
      created_at: "2026-07-25T00:00:00Z",
      deliveries: [{
        id: "delivery-1",
        event_type: "order.completed",
        status: "delivered",
        response_code: 204,
        response_body: "",
        attempts: 1,
        next_retry_at: null,
        created_at: "2026-07-25T00:00:00Z",
        delivered_at: "2026-07-25T00:00:01Z",
      }],
    });
    const detail = await detailRoute(
      new Request("http://localhost/detail") as NextRequest,
      detailContext,
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.logs[0]).toMatchObject({
      eventType: "order.completed",
      responseStatus: 204,
    });

    h.patch.mockResolvedValue({});
    const patched = await patchRoute(
      new Request("http://localhost/detail", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      }) as NextRequest,
      detailContext,
    );
    expect(patched.status).toBe(200);
    expect(h.patch).toHaveBeenCalledWith(
      "v2-event-1",
      "go-webhook-1",
      expect.objectContaining({ is_active: false }),
    );

    h.remove.mockResolvedValue({ deleted: true });
    const deleted = await deleteRoute(
      new Request("http://localhost/detail", { method: "DELETE" }) as NextRequest,
      detailContext,
    );
    expect(deleted.status).toBe(200);
    expect(h.remove).toHaveBeenCalledWith("v2-event-1", "go-webhook-1");
  });
});

// 레벨2 컷오버 T2-EVT — go events 앵커 제거 후에도 miss 의미(409/404)와 v2 장애(503)가 유지되는지.
describe("webhook route 이벤트 소유 경계(T2-EVT)", () => {
  it("미소유/미동기화 이벤트면 목록은 409 이고 v2 웹훅 API 를 부르지 않는다", async () => {
    h.resolveOwned.mockResolvedValue(null);
    const response = await listRoute(
      new Request("http://localhost/api/events/go-event-1/webhooks") as NextRequest,
      collectionContext,
    );
    expect(response.status).toBe(409);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("미소유/미동기화 이벤트면 생성도 409 이고 v2 생성 호출이 없다", async () => {
    h.resolveOwned.mockResolvedValue(null);
    const response = await createRoute(
      new Request("http://localhost/api/events/go-event-1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ERP",
          endpointUrl: "https://hooks.example.com/",
          subscribedEvents: ["order.completed"],
        }),
      }) as NextRequest,
      collectionContext,
    );
    expect(response.status).toBe(409);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("미소유 이벤트면 상세는 404(타 계정 웹훅 노출 금지)", async () => {
    h.resolveOwned.mockResolvedValue(null);
    const detail = await detailRoute(
      new Request("http://localhost/detail") as NextRequest,
      detailContext,
    );
    expect(detail.status).toBe(404);
    expect(h.get).not.toHaveBeenCalled();
  });

  it("v2 장애는 409/404 로 뭉개지 않고 503 으로 구분한다", async () => {
    h.resolveOwned.mockRejectedValue(
      new h.MockEventAccessError("커머스 서버에 연결할 수 없습니다", "unavailable", 502),
    );
    const list = await listRoute(
      new Request("http://localhost/api/events/go-event-1/webhooks") as NextRequest,
      collectionContext,
    );
    expect(list.status).toBe(503);

    const detail = await detailRoute(
      new Request("http://localhost/detail") as NextRequest,
      detailContext,
    );
    expect(detail.status).toBe(503);
  });
});

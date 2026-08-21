import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    query: vi.fn(),
    getEvent: vi.fn(),
    join: vi.fn(),
    status: vi.fn(),
    createToken: vi.fn(),
    resolveToken: vi.fn(),
    error: vi.fn(),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({ query: h.query }),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: h.error,
  },
}));
vi.mock("@/lib/queue/smart-queue", () => ({
  joinQueue: h.join,
  getQueuePosition: h.status,
  createQueueSessionToken: h.createToken,
  resolveQueueEventFromSessionToken: h.resolveToken,
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  getEvent: h.getEvent,
  getEventBySlug: vi.fn(),
}));

import { POST as joinRoute } from "./join/route";
import { GET as statusRoute } from "./status/route";

const context = { params: Promise.resolve({ eventId: "go-event-1" }) };
const sessionToken = "anonymous-session-0001";

beforeEach(() => {
  h.query.mockReset();
  h.getEvent.mockReset();
  h.join.mockReset();
  h.status.mockReset();
  h.createToken.mockReset();
  h.resolveToken.mockReset();
  h.error.mockReset();
  h.createToken.mockReturnValue(sessionToken);
  h.resolveToken.mockReturnValue("v2-event-1");
});

describe("public queue v2 flip", () => {
  it("go DB 없이 v2 이벤트 설정으로 대기열 참여를 위임한다", async () => {
    // W2-PUB: ID 승격 — URL eventId 가 곧 v2 canonical id 다(앵커 조회 없음).
    h.getEvent.mockResolvedValue({
      event_id: "go-event-1",
      status: "live",
      queue_enabled: true,
      queue_config: { maxConcurrent: 37 },
    });
    h.join.mockResolvedValue({
      sessionToken,
      position: 4,
      status: "waiting",
      estimatedWait: 9,
      totalWaiting: 12,
      accessToken: null,
    });

    const response = await joinRoute(
      new Request("http://localhost/queue/join", { method: "POST" }) as NextRequest,
      context,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      sessionToken,
      position: 4,
      status: "waiting",
    });
    expect(h.createToken).toHaveBeenCalledWith("go-event-1", "go-event-1");
    expect(h.join).toHaveBeenCalledWith("go-event-1", 37, sessionToken);
    // 🔴 go DB 왕복 0 — 이 라우트에서 events 조회가 사라졌다.
    expect(h.query).not.toHaveBeenCalled();
  });

  it("queue_enabled=false 는 우회, 미존재 이벤트는 404, v2 장애는 503", async () => {
    h.getEvent.mockResolvedValueOnce({
      event_id: "go-event-1",
      status: "live",
      queue_enabled: false,
      queue_config: null,
    });
    const bypassed = await joinRoute(
      new Request("http://localhost/queue/join", { method: "POST" }) as NextRequest,
      context,
    );
    expect(bypassed.status).toBe(200);
    expect((await bypassed.json()).data.status).toBe("active");
    expect(h.join).not.toHaveBeenCalled();

    h.getEvent.mockRejectedValueOnce(new h.MockV2CommerceError("nope", 404));
    const missing = await joinRoute(
      new Request("http://localhost/queue/join", { method: "POST" }) as NextRequest,
      context,
    );
    expect(missing.status).toBe(404);
    expect(h.join).not.toHaveBeenCalled();

    // 🔴 v2 장애를 404 로 뭉개지 않는다 — 재시도 가능 신호(503).
    h.getEvent.mockRejectedValueOnce(new h.MockV2CommerceError("down", 500));
    const unavailable = await joinRoute(
      new Request("http://localhost/queue/join", { method: "POST" }) as NextRequest,
      context,
    );
    expect(unavailable.status).toBe(503);
    expect(h.join).not.toHaveBeenCalled();
  });

  it("reads status only from the selected event's v2 queue", async () => {
    h.status.mockResolvedValue({
      position: 0,
      status: "active",
      estimatedWait: 0,
      totalWaiting: 2,
      accessToken: "admission-token",
    });

    const response = await statusRoute(
      new Request(
        `http://localhost/queue/status?token=${sessionToken}`,
      ) as NextRequest,
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.json()).data.status).toBe("active");
    expect(h.status).toHaveBeenCalledWith("v2-event-1", sessionToken);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.resolveToken).toHaveBeenCalledWith(sessionToken, "go-event-1");
  });

  it("rejects a token scoped to another go event without touching v2", async () => {
    h.resolveToken.mockReturnValue(null);
    const response = await statusRoute(
      new Request(
        `http://localhost/queue/status?token=${sessionToken}`,
      ) as NextRequest,
      context,
    );

    expect(response.status).toBe(400);
    expect(h.status).not.toHaveBeenCalled();
  });
});

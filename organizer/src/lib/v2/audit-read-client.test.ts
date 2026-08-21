import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAuditLogs, fetchComplianceAudit, V2AuditReadError } from "./audit-read-client";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.V2_INTERNAL_BASE_URL = "https://v2.test";
  process.env.GO_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...OLD_ENV };
});

describe("fetchAuditLogs — v2 조회 프록시", () => {
  it("account_id 경계 + 필터를 쿼리스트링으로 전달, snake→camel 매핑", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          logs: [
            {
              id: "l1",
              account_id: "acc1",
              user_id: "u1",
              action: "refund",
              table_name: "orders",
              record_id: "o1",
              changes: { eventId: "e1" },
              ip_address: "1.2.3.4",
              created_at: "2026-07-24T00:00:00Z",
            },
          ],
          total: 1,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchAuditLogs({
      accountId: "acc1",
      resourceTypes: ["events", "orders"],
      eventId: "e1",
      limit: 10,
    });

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/v1/internal/audit-logs?");
    expect(url).toContain("account_id=acc1");
    expect(url).toContain("resource_types=events%2Corders");
    expect(url).toContain("event_id=e1");
    expect(url).toContain("limit=10");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Pickket-Signature"]).toMatch(/^[a-f0-9]{64}$/);

    expect(res.total).toBe(1);
    expect(res.logs[0]).toMatchObject({
      id: "l1",
      accountId: "acc1",
      userId: "u1",
      tableName: "orders",
      recordId: "o1",
      ipAddress: "1.2.3.4",
    });
  });

  it("v2 실제 200 빈 목록이면 빈 결과(정상 없음)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ logs: [], total: 0 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchAuditLogs({ accountId: "acc1" });
    expect(res).toEqual({ logs: [], total: 0 });
  });

  it("fail-closed: v2 5xx 는 502 V2AuditReadError(장애를 없음으로 위장 금지)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAuditLogs({ accountId: "acc1" })).rejects.toMatchObject({
      name: "V2AuditReadError",
      status: 502,
    });
    await expect(fetchAuditLogs({ accountId: "acc1" })).rejects.toBeInstanceOf(V2AuditReadError);
  });

  it("fail-closed: 미설정이면 호출 없이 503 V2AuditReadError", async () => {
    delete process.env.V2_INTERNAL_BASE_URL;
    delete process.env.GO_WEBHOOK_SECRET;
    delete process.env.V2_EVENT_SYNC_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAuditLogs({ accountId: "acc1" })).rejects.toMatchObject({
      name: "V2AuditReadError",
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fail-closed: fetch throw(네트워크/timeout) 도 502 V2AuditReadError(swallow 금지)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAuditLogs({ accountId: "acc1" })).rejects.toMatchObject({
      name: "V2AuditReadError",
      status: 502,
    });
  });
});

describe("fetchComplianceAudit — 이벤트 감사 추적 프록시", () => {
  it("account_id·event_id 경계 전달, logs+stats 그대로 반환", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          logs: [
            {
              id: "l1",
              action: "delete",
              tableName: "orders",
              recordId: "o9",
              changes: { eventId: "e1" },
              ipAddress: null,
              createdAt: "2026-07-24T00:00:00Z",
              userName: null,
              userEmail: null,
              userId: "u1",
            },
          ],
          stats: { totalLogs: 1, uniqueUsers: 1, tablesAffected: 1, deleteActions: 1 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchComplianceAudit({ accountId: "acc1", eventId: "e1", limit: 30 });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/v1/internal/audit-logs/compliance?");
    expect(url).toContain("account_id=acc1");
    expect(url).toContain("event_id=e1");
    expect(res.stats).toEqual({ totalLogs: 1, uniqueUsers: 1, tablesAffected: 1, deleteActions: 1 });
    expect(res.logs[0]?.userName).toBeNull();
  });

  it("fail-closed: 실패 시 V2AuditReadError(빈 통계 위장 금지)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("x"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchComplianceAudit({ accountId: "acc1", eventId: "e1" })).rejects.toMatchObject({
      name: "V2AuditReadError",
      status: 502,
    });
  });

  it("fail-closed: 미설정이면 503 V2AuditReadError", async () => {
    delete process.env.V2_INTERNAL_BASE_URL;
    delete process.env.GO_WEBHOOK_SECRET;
    delete process.env.V2_EVENT_SYNC_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchComplianceAudit({ accountId: "acc1", eventId: "e1" })).rejects.toMatchObject({
      name: "V2AuditReadError",
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

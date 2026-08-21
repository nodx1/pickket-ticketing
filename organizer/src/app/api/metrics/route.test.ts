import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, getMessagingMetrics } = vi.hoisted(() => ({
  getPool: vi.fn(),
  getMessagingMetrics: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
// W5-MSG: 발송 원장(message_deliveries/_attempts) 게이지는 v2 경유.
vi.mock("@/lib/v2/messaging-ledger-client", () => ({ getMessagingMetrics }));

import { GET } from "@/app/api/metrics/route";

describe("metrics audit outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client), __queries: queries });
    getMessagingMetrics.mockResolvedValue({ queues: [], provider_errors: [] });
  });

  it("queries and exports audit_outbox queue", async () => {
    const response = await GET(new Request("https://go.test/metrics"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("audit_outbox_review");
    const pool = getPool.mock.results[0].value as { __queries: string[] };
    expect(pool.__queries.some((sql) => sql.includes("FROM audit_outbox"))).toBe(true);
    // W5-MSG: 발송 원장은 go DB 를 더 이상 조회하지 않는다(v2 단일 정본).
    expect(pool.__queries.some((sql) => sql.includes("FROM message_deliveries"))).toBe(false);
    expect(pool.__queries.some((sql) => sql.includes("FROM message_delivery_attempts"))).toBe(false);
  });

  // 🔴 fail-closed: 발송 원장에 못 닿으면 "미확정 0건"으로 보이는 200 을 내보내지 않는다.
  it("발송 원장 조회 실패 시 200 대신 503 — 큐가 비어 보이는 침묵을 만들지 않는다", async () => {
    getMessagingMetrics.mockRejectedValue(new Error("ledger unreachable"));
    const response = await GET(new Request("https://go.test/metrics"));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("metrics unavailable");
  });
});

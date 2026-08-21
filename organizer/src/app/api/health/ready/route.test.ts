import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  ping: vi.fn(),
}));

vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({ query: h.query }),
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ ping: h.ping }),
}));

import { GET, HARD_REQUIRED_SCHEMA_MIGRATIONS } from "@/app/api/health/ready/route";

describe("readiness schema gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RISE_ENGINE_URL;
    delete process.env.REQUIRED_SCHEMA_MIGRATION;
    h.ping.mockResolvedValue("PONG");
  });

  it("requires every durable recovery migration", () => {
    expect([...HARD_REQUIRED_SCHEMA_MIGRATIONS]).toEqual([
      "224-payment-confirm-outbox.sql",
      "226-audit-outbox.sql",
      "227-compensation-seat-expiry-projection.sql",
      "228-ops-cron-runs-degraded.sql",
      "229-waitlist-claim-recovery.sql",
      "230-compensation-provider-anchored.sql",
      "231-payment-attempts-ledger.sql",
      "232-payment-compensation-attempt-idempotency.sql",
    ]);
  });

  it.each([
    "230-compensation-provider-anchored.sql",
    "231-payment-attempts-ledger.sql",
    "232-payment-compensation-attempt-idempotency.sql",
  ])("%s 미적용 구 스키마는 503 not_ready", async (missingMigration) => {
    const required = [
      "207-provider-reconciliation-identifiers.sql",
      ...HARD_REQUIRED_SCHEMA_MIGRATIONS,
    ].filter((filename) => filename !== missingMigration);
    h.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM schema_migrations")) {
        return { rows: required.map((filename) => ({ filename })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("not_ready");
    expect(body.checks.schema).toMatchObject({ ok: false });
    expect(body.checks.schema.error).toContain(missingMigration);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => h.pool }));

import { recordWaitlistClaimRecovery } from "@/lib/waitlist/claim-recovery";

beforeEach(() => {
  h.pool.query.mockReset();
});

describe("recordWaitlistClaimRecovery", () => {
  it("upserts a pending recovery row keyed by entry_id and redacts PII in the error", async () => {
    h.pool.query.mockResolvedValue({ rowCount: 1 });

    const out = await recordWaitlistClaimRecovery({
      entryId: "e1",
      orderId: "o1",
      accountId: "acc",
      eventId: "evt",
      error: "failed for hong@example.com phone 010-1234-5678",
    });

    expect(out.recorded).toBe(true);
    const [sql, params] = h.pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO waitlist_claim_recovery");
    expect(sql).toContain("ON CONFLICT (entry_id) DO UPDATE");
    // resolved 행 보존 가드가 SQL 에 존재.
    expect(sql).toContain("'resolved'");
    expect(params[0]).toBe("e1");
    expect(params[1]).toBe("o1");
    // PII 마스킹.
    expect(params[4]).not.toContain("hong@example.com");
    expect(params[4]).toContain("[email]");
    expect(params[4]).toContain("[phone]");
  });

  it("returns recorded=false when the DB write fails (surfaced for manual recovery)", async () => {
    h.pool.query.mockRejectedValue(new Error("db down"));

    const out = await recordWaitlistClaimRecovery({ entryId: "e1", orderId: "o1" });

    expect(out.recorded).toBe(false);
  });
});

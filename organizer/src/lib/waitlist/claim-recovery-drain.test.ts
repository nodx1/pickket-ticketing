import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, claimCommit, V2CommerceError, alertWaitlistRecovery } = vi.hoisted(() => ({
  getPool: vi.fn(),
  claimCommit: vi.fn(),
  V2CommerceError: class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
  alertWaitlistRecovery: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/v2/waitlist-client", () => ({ claimCommit }));
vi.mock("@/lib/v2/commerce-client", () => ({ V2CommerceError }));
vi.mock("@/lib/waitlist/recovery-alert", () => ({ alertWaitlistRecovery }));

import { processWaitlistClaimRecovery } from "@/lib/waitlist/claim-recovery-drain";

/** 클레임 트랜잭션 client(BEGIN, lease 회수, max소진 격리, SELECT claim, per-row UPDATE, COMMIT). */
function makeClaimClient(claimRows: unknown[]) {
  const query = vi.fn();
  query.mockResolvedValueOnce({}); // BEGIN
  query.mockResolvedValueOnce({}); // stale lease 회수
  query.mockResolvedValueOnce({}); // max_attempts 소진 격리
  query.mockResolvedValueOnce({ rows: claimRows }); // SELECT ... FOR UPDATE SKIP LOCKED
  for (let i = 0; i < claimRows.length; i++) query.mockResolvedValueOnce({}); // per-row mark-processing
  query.mockResolvedValueOnce({}); // COMMIT
  return { release: vi.fn(), query };
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    entry_id: "entry-1",
    order_id: "order-1",
    account_id: "acc-1",
    event_id: "evt-1",
    attempts: 0,
    max_attempts: 8,
    ...over,
  };
}

describe("waitlist claim recovery drain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-commits with the same orderId and resolves on committed=true (idempotent anchor)", async () => {
    const client = makeClaimClient([row()]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    claimCommit.mockResolvedValue({ converted_order_id: "order-1", committed: true });

    await expect(processWaitlistClaimRecovery()).resolves.toEqual({
      claimed: 1,
      resolved: 1,
      failed: 0,
      manualReview: 0,
    });
    // 재-commit 은 큐에 남은 동일 orderId 로 호출(멱등 재commit).
    expect(claimCommit).toHaveBeenCalledWith("entry-1", "order-1");
    const finalSql = pool.query.mock.calls[0][0] as string;
    expect(finalSql).toContain("status = 'resolved'");
    expect(finalSql).toContain("lease_token = $2::uuid"); // stale 워커 덮어쓰기 방지
  });

  it("resolves on idempotent replay (committed=false but converted_order_id matches)", async () => {
    const client = makeClaimClient([row()]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    claimCommit.mockResolvedValue({ converted_order_id: "order-1", committed: false });

    await expect(processWaitlistClaimRecovery()).resolves.toEqual({
      claimed: 1,
      resolved: 1,
      failed: 0,
      manualReview: 0,
    });
    expect(alertWaitlistRecovery).not.toHaveBeenCalled();
  });

  it("marks failed with backoff on a transient v2 error (not exhausted)", async () => {
    const client = makeClaimClient([row({ attempts: 1 })]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    claimCommit.mockRejectedValue(new V2CommerceError("commit upstream 503", 503));

    await expect(processWaitlistClaimRecovery()).resolves.toEqual({
      claimed: 1,
      resolved: 0,
      failed: 1,
      manualReview: 0,
    });
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'failed'");
    expect(pool.query.mock.calls[0][1]).toEqual(expect.arrayContaining(["entry-1"]));
    expect(alertWaitlistRecovery).not.toHaveBeenCalled();
  });

  it("escalates to manual_review + Sentry when the next attempt exhausts max_attempts", async () => {
    // attempts=7, max=8 → 이 시도(8회차)가 max 소진 → manual_review.
    const client = makeClaimClient([row({ attempts: 7 })]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    claimCommit.mockRejectedValue(new Error("still failing"));

    await expect(processWaitlistClaimRecovery()).resolves.toEqual({
      claimed: 1,
      resolved: 0,
      failed: 0,
      manualReview: 1,
    });
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'manual_review'");
    expect(alertWaitlistRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "manual_review", entryId: "entry-1", orderId: "order-1", reason: "max_attempts_exceeded" }),
    );
  });

  it("escalates to manual_review on anchor mismatch (v2 anchored a different order)", async () => {
    const client = makeClaimClient([row()]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    claimCommit.mockResolvedValue({ converted_order_id: "order-OTHER", committed: false });

    await expect(processWaitlistClaimRecovery()).resolves.toEqual({
      claimed: 1,
      resolved: 0,
      failed: 0,
      manualReview: 1,
    });
    expect(alertWaitlistRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "manual_review", reason: "anchor_mismatch", orderId: "order-1" }),
    );
  });

  it("does not double-count when the final UPDATE loses the lease (stale worker)", async () => {
    const client = makeClaimClient([row()]);
    // 최종 UPDATE 가 lease 불일치로 0행 → resolved 로 세지 않는다(다른 워커가 이미 처리).
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    getPool.mockReturnValue(pool);
    claimCommit.mockResolvedValue({ converted_order_id: "order-1", committed: true });

    await expect(processWaitlistClaimRecovery()).resolves.toEqual({
      claimed: 1,
      resolved: 0,
      failed: 0,
      manualReview: 0,
    });
  });

  it("is a no-op when there are no pending rows", async () => {
    const client = makeClaimClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    getPool.mockReturnValue(pool);

    await expect(processWaitlistClaimRecovery()).resolves.toEqual({
      claimed: 0,
      resolved: 0,
      failed: 0,
      manualReview: 0,
    });
    expect(claimCommit).not.toHaveBeenCalled();
  });
});

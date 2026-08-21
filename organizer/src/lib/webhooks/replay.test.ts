import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  poolQuery: vi.fn(),
  replayV2: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ connect: async () => ({ query: h.clientQuery, release: vi.fn() }), query: h.poolQuery }) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/v2/commerce-client", () => ({ replayInterServiceWebhook: h.replayV2 }));

import { replayDeadLetteredWebhook } from "./replay";

const payload = { event: "order.payment.confirmed", delivery_id: "00000000-0000-0000-0000-000000000001", timestamp: new Date().toISOString(), order_id: "00000000-0000-0000-0000-000000000002", data: {} };
const row = { row_id: 7, delivery_id: payload.delivery_id, event: payload.event, payload, payload_fingerprint: "fp", computed_fingerprint: "fp", status: "dead_lettered", replay_status: "none", replay_count: 0, replay_requested_at: null, replay_attempt_id: null, account_id: "acct", order_id: payload.order_id, order_status: "expired", v2_event_id: "00000000-0000-0000-0000-000000000003" };
const input = { deliveryRowId: "7", accountId: "acct", actorId: "owner", operationKey: "op-7", reason: "order was created after DLQ" };

afterEach(() => {
  h.clientQuery.mockReset();
  h.poolQuery.mockReset();
  h.replayV2.mockReset();
});

describe("dead-letter webhook replay", () => {
  it("supports dry-run without creating an attempt or mutating the original", async () => {
    h.clientQuery.mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [row] }) // lock
      .mockResolvedValueOnce({}); // ROLLBACK
    await expect(replayDeadLetteredWebhook({ ...input, dryRun: true })).resolves.toMatchObject({ status: "processed", dryRun: true });
    expect(h.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO webhook_delivery_replay_attempts"))).toBe(false);
  });

  it("records an immutable replay attempt, delegates resend to v2, and stores the queued result", async () => {
    h.clientQuery.mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ id: "replay-1" }] })
      .mockResolvedValueOnce({}) // original replay marker
      .mockResolvedValueOnce({}) // audit
      .mockResolvedValueOnce({}); // COMMIT
    h.replayV2.mockResolvedValue({
      status: "queued",
      original_delivery_id: payload.delivery_id,
      delivery_id: "00000000-0000-0000-0000-000000000004",
    });
    h.poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(replayDeadLetteredWebhook(input)).resolves.toMatchObject({ status: "pending", deliveryId: payload.delivery_id, replayAttemptId: "replay-1" });
    expect(h.replayV2).toHaveBeenCalledWith(
      row.v2_event_id,
      payload.delivery_id,
      { idempotencyKey: input.operationKey },
    );
    // P1 트랜잭션 아웃박스: 감사는 동일 txn(client)으로 audit_outbox 에 적재(직접 audit_logs 금지).
    expect(h.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO audit_outbox"))).toBe(true);
    expect(h.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO audit_logs"))).toBe(false);
    expect(h.poolQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE webhook_delivery_replay_attempts"))).toBe(true);
  });

  it("quarantines a tampered or malformed payload instead of replaying it", async () => {
    const invalid = { ...row, payload_fingerprint: "different" };
    h.clientQuery.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [invalid] })
      .mockResolvedValueOnce({ rows: [{ id: "replay-q" }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await expect(replayDeadLetteredWebhook(input)).resolves.toMatchObject({ status: "quarantined" });
    expect(h.replayV2).not.toHaveBeenCalled();
  });

  it("does not disclose or cross tenant replay rows", async () => {
    h.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});
    await expect(replayDeadLetteredWebhook(input)).resolves.toMatchObject({ status: "failed", reason: "not_found" });
  });
});

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { getTossPaymentByPaymentKey, tossCancel } = vi.hoisted(() => ({
  getTossPaymentByPaymentKey: vi.fn(),
  tossCancel: vi.fn(),
}));

vi.mock("@/lib/payment/toss", () => ({
  getTossPaymentByPaymentKey,
  tossProvider: { cancel: tossCancel },
}));
vi.mock("@/lib/payment/confirm-outbox", () => ({
  processPaymentConfirmOutbox: vi.fn(),
}));

import { getPool } from "@/lib/db/pool";
import { reconcileOrphanTossPendingPayments } from "@/lib/payment/reconcile";

const describeIntegration = describe.skipIf(process.env.RUN_INTEGRATION !== "1");
const accountId = crypto.randomUUID();
const organizerId = crypto.randomUUID();
const eventId = crypto.randomUUID();
const orderId = crypto.randomUUID();
const v2OrderId = crypto.randomUUID();
const winnerKey = "toss_winner_integration";
const loserKeys = ["toss_loser_integration_1", "toss_loser_integration_2"];

describeIntegration("Toss orphan candidate SQL integration", () => {
  beforeAll(async () => {
    const pool = getPool();
    await pool.query(
      "INSERT INTO accounts (id,name,slug,contact_email) VALUES ($1,'Reconcile Audit',$2,$3)",
      [accountId, `reconcile-${accountId}`, `${accountId}@example.test`],
    );
    await pool.query(
      "INSERT INTO organizers (id,account_id,name,slug) VALUES ($1,$2,'Reconcile Audit Organizer',$3)",
      [organizerId, accountId, `reconcile-${organizerId}`],
    );
    await pool.query(
      `INSERT INTO events (id,account_id,organizer_id,title,slug,starts_at,ends_at,status)
       VALUES ($1,$2,$3,'Reconcile Audit Event',$4,NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day 1 hour','live')`,
      [eventId, accountId, organizerId, `reconcile-${eventId}`],
    );
    await pool.query(
      `INSERT INTO orders
        (id,account_id,event_id,order_number,buyer_name,buyer_email,total_amount,paid_amount,
         refund_amount,status,payment_method,payment_status,payment_reference,v2_order_id,updated_at)
       VALUES ($1,$2,$3,$4,'Audit Buyer',$5,15000,15000,0,'completed','toss','paid',$6,$7,
               NOW()-INTERVAL '30 minutes')`,
      [
        orderId,
        accountId,
        eventId,
        `AUDIT-${orderId.slice(0, 8)}`,
        `${orderId}@example.test`,
        winnerKey,
        v2OrderId,
      ],
    );
    for (const paymentKey of loserKeys) {
      await pool.query(
        `INSERT INTO payment_attempts
          (order_id,provider,payment_key,amount,status,updated_at)
         VALUES ($1,'toss',$2,15000,'pending',NOW()-INTERVAL '30 minutes')`,
        [orderId, paymentKey],
      );
    }
    getTossPaymentByPaymentKey.mockResolvedValue({ status: "DONE", totalAmount: 15000 });
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM orders WHERE id = $1", [orderId]);
    await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    await pool.end();
  });

  it("completed 주문의 미정산 비승자 attempts를 실제 SQL로 찾아 키별 보상행을 만든다", async () => {
    const summary = await reconcileOrphanTossPendingPayments(10);
    expect(summary).toEqual({ scanned: 2, refunding: 2, stillPending: 0, lookupFailed: 0 });

    const pool = getPool();
    const order = await pool.query("SELECT status,payment_reference FROM orders WHERE id = $1", [orderId]);
    expect(order.rows[0]).toEqual({ status: "completed", payment_reference: winnerKey });

    const attempts = await pool.query(
      `SELECT payment_key,status FROM payment_attempts
        WHERE order_id = $1 ORDER BY payment_key`,
      [orderId],
    );
    expect(attempts.rows).toEqual(
      loserKeys.map((paymentKey) => ({ payment_key: paymentKey, status: "settled" })),
    );

    const actions = await pool.query(
      `SELECT provider_payment_key,idempotency_key,status
         FROM payment_compensation_actions
        WHERE order_id = $1 ORDER BY provider_payment_key`,
      [orderId],
    );
    expect(actions.rows).toEqual(
      loserKeys.map((paymentKey) => ({
        provider_payment_key: paymentKey,
        idempotency_key: `toss:${paymentKey}`,
        status: "pending",
      })),
    );
  });
});

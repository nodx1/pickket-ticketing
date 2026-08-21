/**
 * Real PostgreSQL integration test for the go order repair/expiry SQL.
 *
 * Run from `organizer/` against the disposable, migration-current local DB:
 *
 *   DB_PASSWORD="$(docker exec pickket-go-postgres printenv POSTGRES_PASSWORD)" && \
 *   RUN_INTEGRATION=1 PG_HOST=127.0.0.1 PG_PORT=5434 PG_USER=pickket \
 *   PG_PASSWORD="$DB_PASSWORD" PG_DATABASE=pickket_go_e2e \
 *   npx vitest run src/lib/orders/order-repair-postgres.integration.test.ts
 *
 * Never point this test at production. It inserts and deletes its own fixtures.
 */
import crypto from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  askV2AboutOrder: vi.fn(),
  reapInventory: vi.fn(),
  sendPurchaseConfirm: vi.fn(),
  startCronRun: vi.fn(),
  finishCronRun: vi.fn(),
}));

vi.mock("@/lib/orders/v2-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orders/v2-authority")>();
  return { ...actual, askV2AboutOrder: mocked.askV2AboutOrder };
});

vi.mock("@/lib/v2/commerce-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/v2/commerce-client")>();
  return { ...actual, reapInventory: mocked.reapInventory };
});

vi.mock("@/lib/notification/purchase-confirm-sender", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notification/purchase-confirm-sender")>();
  return { ...actual, sendPurchaseConfirm: mocked.sendPurchaseConfirm };
});

vi.mock("@/lib/ops/cron-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/cron-run")>();
  return {
    ...actual,
    startCronRun: mocked.startCronRun,
    finishCronRun: mocked.finishCronRun,
  };
});

import { GET as expireOrders } from "@/app/api/cron/expire-orders/route";
import { getPool } from "@/lib/db/pool";
import { reconcileOrderState } from "@/lib/orders/reconcile-order-state";
import { repairPaidOrder } from "@/lib/orders/repair-paid-order";
import { repairOrderToPaid } from "@/lib/state-machine/order-state-machine";

const integration = process.env.RUN_INTEGRATION === "1";
const describeIntegration = describe.skipIf(!integration);
const accountId = crypto.randomUUID();
const eventId = crypto.randomUUID();
const createdOrderIds = new Set<string>();

interface OrderFixture {
  status?: "pending" | "completed" | "cancelled" | "refunded" | "partially_refunded" | "expired";
  expiresAt?: Date | null;
  updatedAt?: Date;
  totalAmount?: number;
  paidAmount?: number;
  paymentStatus?: string;
  v2OrderId?: string | null;
}

async function insertOrder(input: OrderFixture = {}) {
  const orderId = crypto.randomUUID();
  const v2OrderId = input.v2OrderId === undefined ? crypto.randomUUID() : input.v2OrderId;
  createdOrderIds.add(orderId);
  await getPool().query(
    `INSERT INTO orders
      (id, account_id, event_id, order_number, buyer_name, buyer_email,
       total_amount, paid_amount, refund_amount, status, payment_method,
       payment_status, payment_reference, expires_at, updated_at, v2_order_id)
     VALUES
      ($1, $2, $3, $4, 'Integration Buyer', $5,
       $6, $7, 0, $8, 'toss',
       $9, NULL, $10, $11, $12)`,
    [
      orderId,
      accountId,
      eventId,
      `IT-${orderId}`,
      `${orderId}@example.test`,
      input.totalAmount ?? 14_500,
      input.paidAmount ?? 0,
      input.status ?? "pending",
      input.paymentStatus ?? "pending",
      input.expiresAt === undefined ? new Date(Date.now() - 60_000) : input.expiresAt,
      input.updatedAt ?? new Date(),
      v2OrderId,
    ],
  );
  return { orderId, v2OrderId };
}

async function insertAttendee(
  orderId: string,
  status: "pending" | "confirmed" | "cancelled" | "checked_in",
) {
  const attendeeId = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO attendees
      (id, account_id, event_id, order_id, ticket_number, name, status)
     VALUES ($1, $2, $3, $4, $5, 'Integration Attendee', $6)`,
    [attendeeId, accountId, eventId, orderId, `IT-TICKET-${attendeeId}`, status],
  );
  return attendeeId;
}

async function insertCompensation(
  orderId: string,
  v2OrderId: string,
  status:
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "failed_retryable"
    | "unknown"
    | "manual_review"
    | "cancelled",
  idempotencyKey: string = crypto.randomUUID(),
) {
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO payment_compensation_actions
      (id, order_id, v2_order_id, action, reason, requested_amount,
       status, provider_name, idempotency_key)
     VALUES ($1, $2, $3, 'refund', 'integration fixture', 14500,
             $4, 'v2', $5)`,
    [id, orderId, v2OrderId, status, idempotencyKey],
  );
  return id;
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixtures() {
  if (createdOrderIds.size === 0) return;
  const ids = [...createdOrderIds];
  createdOrderIds.clear();
  await getPool().query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [ids]);
}

function cronRequest() {
  return new Request("http://localhost/api/cron/expire-orders", {
    headers: { authorization: "Bearer integration-cron-secret" },
  });
}

describeIntegration("order repair/expiry SQL against real PostgreSQL", () => {
  beforeAll(async () => {
    const migrationsFromCwd = path.resolve(process.cwd(), "migrations");
    const migrationsDir = existsSync(migrationsFromCwd)
      ? migrationsFromCwd
      : path.resolve(process.cwd(), "organizer/migrations");
    const migrationFileCount = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).length;
    const schemaResult = await getPool().query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM schema_migrations",
    );
    const schemaMigrationCount = schemaResult.rows[0]?.count ?? -1;
    const schemaCounts =
      `migration files=${migrationFileCount}, ` +
      `schema_migrations=${schemaMigrationCount}`;
    console.info(`[order-repair integration] schema check: ${schemaCounts}`);
    expect(schemaMigrationCount, `go integration schema mismatch: ${schemaCounts}`).toBe(
      migrationFileCount,
    );
  });

  beforeEach(() => {
    process.env.CRON_SECRET = "integration-cron-secret";
    mocked.askV2AboutOrder.mockReset();
    mocked.reapInventory.mockReset();
    mocked.sendPurchaseConfirm.mockReset();
    mocked.startCronRun.mockReset();
    mocked.finishCronRun.mockReset();
    mocked.reapInventory.mockResolvedValue({
      holds_reaped: 0,
      seats_released: 0,
      orders_expired: 0,
    });
    mocked.sendPurchaseConfirm.mockResolvedValue({
      sent: true,
      ticketNumber: "IT-TICKET",
      attempted: 1,
      failed: 0,
    });
    mocked.startCronRun.mockResolvedValue({ id: crypto.randomUUID(), startedAt: Date.now() });
    mocked.finishCronRun.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await cleanupFixtures();
  });

  afterAll(async () => {
    await cleanupFixtures();
    await getPool().end();
    globalThis.__pickketPool = undefined;
  });

  it("repairOrderToPaid applies once and the second call is a zero-row noop", async () => {
    const { orderId } = await insertOrder({ status: "expired" });

    const [first, second, row] = await inTransaction(async (client) => {
      const firstResult = await repairOrderToPaid(client, orderId, "paid");
      const secondResult = await repairOrderToPaid(client, orderId, "paid");
      const current = await client.query<{ status: string; expires_at: Date | null }>(
        "SELECT status, expires_at FROM orders WHERE id = $1",
        [orderId],
      );
      return [firstResult, secondResult, current.rows[0]!] as const;
    });

    expect(first).toEqual({ status: "applied", from: "expired" });
    expect(second).toEqual({ status: "noop" });
    expect(row).toEqual({ status: "completed", expires_at: null });
  });

  it("repairPaidOrder projects the paid amount, restores only eligible attendees, and cancels retryable compensations", async () => {
    const { orderId, v2OrderId } = await insertOrder({
      status: "expired",
      totalAmount: 14_500,
      paidAmount: 0,
    });
    const cancelledId = await insertAttendee(orderId, "cancelled");
    const pendingId = await insertAttendee(orderId, "pending");
    const checkedInId = await insertAttendee(orderId, "checked_in");
    await insertCompensation(orderId, v2OrderId!, "failed_retryable", "integration-retryable");
    await insertCompensation(orderId, v2OrderId!, "unknown", "integration-unknown");

    const outcome = await inTransaction((client) =>
      repairPaidOrder(client, orderId, {
        v2Status: "paid",
        v2OrderId,
        amount: 14_500,
        method: "card",
        paymentReference: "integration-paid-reference",
      }),
    );

    const order = await getPool().query<{
      status: string;
      payment_status: string;
      paid_amount: string;
    }>("SELECT status, payment_status, paid_amount FROM orders WHERE id = $1", [orderId]);
    const attendees = await getPool().query<{ id: string; status: string }>(
      "SELECT id, status FROM attendees WHERE order_id = $1 ORDER BY id",
      [orderId],
    );
    const compensation = await getPool().query<{ status: string }>(
      "SELECT status FROM payment_compensation_actions WHERE order_id = $1 ORDER BY id",
      [orderId],
    );

    expect(outcome).toMatchObject({
      repaired: true,
      attendeesRestored: 2,
      compensationsCancelled: 2,
      shouldNotify: true,
    });
    expect(order.rows[0]).toEqual({
      status: "completed",
      payment_status: "paid",
      paid_amount: "14500",
    });
    expect(new Map(attendees.rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [cancelledId, "confirmed"],
        [pendingId, "confirmed"],
        [checkedInId, "checked_in"],
      ]),
    );
    expect(compensation.rows).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
  });

  it.each(["processing", "completed", "manual_review"] as const)(
    "does not repair an order when compensation is %s",
    async (compensationStatus) => {
      const { orderId, v2OrderId } = await insertOrder({ status: "expired" });
      await insertCompensation(orderId, v2OrderId!, compensationStatus);

      const outcome = await inTransaction((client) =>
        repairPaidOrder(client, orderId, {
          v2Status: "paid",
          v2OrderId,
          amount: 14_500,
        }),
      );
      const order = await getPool().query<{ status: string }>(
        "SELECT status FROM orders WHERE id = $1",
        [orderId],
      );

      expect(outcome).toEqual({
        repaired: false,
        attendeesRestored: 0,
        compensationsCancelled: 0,
        shouldNotify: false,
      });
      expect(order.rows[0]?.status).toBe("expired");
    },
  );

  it("partially_refunded repairs only the order anchor and suppresses attendee restore/notification", async () => {
    const { orderId, v2OrderId } = await insertOrder({ status: "expired" });
    const attendeeId = await insertAttendee(orderId, "cancelled");

    const outcome = await inTransaction((client) =>
      repairPaidOrder(client, orderId, {
        v2Status: "partially_refunded",
        v2OrderId,
        amount: 14_500,
      }),
    );
    const attendee = await getPool().query<{ status: string }>(
      "SELECT status FROM attendees WHERE id = $1",
      [attendeeId],
    );

    expect(outcome).toMatchObject({
      repaired: true,
      attendeesRestored: 0,
      shouldNotify: false,
    });
    expect(attendee.rows[0]?.status).toBe("cancelled");
    expect(mocked.sendPurchaseConfirm).not.toHaveBeenCalled();
  });

  it("expire-orders leaves a past-due go anchor pending when v2 says paid", async () => {
    const { orderId, v2OrderId } = await insertOrder({ status: "pending" });
    mocked.askV2AboutOrder.mockResolvedValue({
      kind: "paid",
      v2OrderId,
      v2Status: "paid",
    });

    const response = await expireOrders(cronRequest());
    const body = await response.json();
    const order = await getPool().query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [orderId],
    );

    expect(response.status).toBe(200);
    expect(body.data.paidSkipped).toBe(1);
    expect(body.data.goAnchorsExpired).toBe(0);
    expect(order.rows[0]?.status).toBe("pending");
  });

  it("expire-orders expires a past-due order only after a terminal v2 verdict", async () => {
    const { orderId, v2OrderId } = await insertOrder({ status: "pending" });
    mocked.askV2AboutOrder.mockResolvedValue({
      kind: "terminal",
      v2OrderId,
      v2Status: "expired",
    });

    const response = await expireOrders(cronRequest());
    const body = await response.json();
    const order = await getPool().query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [orderId],
    );

    expect(response.status).toBe(200);
    expect(body.data.goAnchorsExpired).toBe(1);
    expect(order.rows[0]?.status).toBe("expired");
  });

  it("expire-orders attendee sweep cancels an attendee on a recent expired order", async () => {
    const { orderId } = await insertOrder({
      status: "expired",
      expiresAt: null,
      updatedAt: new Date(),
    });
    const attendeeId = await insertAttendee(orderId, "confirmed");

    const response = await expireOrders(cronRequest());
    const body = await response.json();
    const attendee = await getPool().query<{ status: string }>(
      "SELECT status FROM attendees WHERE id = $1",
      [attendeeId],
    );

    expect(response.status).toBe(200);
    expect(body.data.attendeesCancelled).toBe(1);
    expect(attendee.rows[0]?.status).toBe("cancelled");
    expect(mocked.askV2AboutOrder).not.toHaveBeenCalled();
  });

  it("reconcile scans only orders whose payment window passed and repairs the stale anchor", async () => {
    const past = await insertOrder({
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 120_000),
    });
    const insideWindow = await insertOrder({
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(Date.now() - 180_000),
    });
    mocked.askV2AboutOrder.mockImplementation(async (goOrderId: string) => ({
      kind: "paid",
      v2OrderId: goOrderId === past.orderId ? past.v2OrderId : insideWindow.v2OrderId,
      v2Status: "paid",
      facts: { amount: 15000, method: "card" },
    }));

    const summary = await reconcileOrderState();
    const orders = await getPool().query<{ id: string; status: string }>(
      "SELECT id, status FROM orders WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[past.orderId, insideWindow.orderId]],
    );
    const statusById = new Map(orders.rows.map((row) => [row.id, row.status]));

    expect(summary).toMatchObject({
      scanned: 1,
      repaired: 1,
      notified: 1,
      notifyFailed: 0,
    });
    expect(mocked.askV2AboutOrder).toHaveBeenCalledTimes(1);
    expect(mocked.askV2AboutOrder).toHaveBeenCalledWith(past.orderId);
    expect(mocked.sendPurchaseConfirm).toHaveBeenCalledTimes(1);
    expect(statusById.get(past.orderId)).toBe("completed");
    expect(statusById.get(insideWindow.orderId)).toBe("pending");

    // 🔴 대사 경로가 금액·수단을 실제로 적는지. 2026-07-31 배포 후 실측에서
    //    paid_amount=0 · payment_method=offline 로 남았다(실제 15,000원 카드).
    //    repairPaidOrder 를 직접 호출하는 테스트는 이걸 못 잡는다 — **대사를 거쳐야** 잡힌다.
    const paid = await getPool().query<{ paid_amount: string; payment_method: string | null }>(
      "SELECT paid_amount, payment_method FROM orders WHERE id = $1",
      [past.orderId],
    );
    expect(Number(paid.rows[0]!.paid_amount)).toBe(15000);
    expect(paid.rows[0]!.payment_method).toBe("card");
  });
});

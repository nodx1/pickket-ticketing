import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";

/**
 * 🔴 발송 스파이 (2026-08-01).
 *
 * 종전엔 목이 **없어서** 통합테스트가 실제 발송을 시도하고 있었다. 그래서
 * "재도착 때 발송을 건너뛰는가"·"실패하면 표식이 풀리는가" 를 **볼 수 없었고**,
 * 선점 결과를 무시하는 변경(M2)과 실패 시 해제를 없애는 변경(M4)이 뮤테이션에서
 * 살아남았다. 표식 시각만 봐서는 그 둘을 구분할 수 없다 — **호출 횟수**를 봐야 한다.
 */
const notifySpy = vi.hoisted(() => ({
  fn: vi.fn(),
  shouldThrow: false,
  /**
   * 🔴 **실제 함수는 예외를 던지지 않는다.** `fanout` 이 채널별 실패를 삼키고
   *    `{attempted, failed}` 로만 돌려준다(transactional.ts 의 H-02 주석).
   *    목이 reject 하도록만 만들면 catch 경로는 **도달 불가한 코드**인데 초록이 된다
   *    — 목킹한 경계는 계약이 아니다. 그래서 **반환값**을 조종할 수 있게 둔다.
   */
  result: { attempted: 2, failed: 0 } as { attempted: number; failed: number },
}));
vi.mock("@/lib/notification/transactional", () => ({
  notifyRefundConfirm: (...args: unknown[]) => {
    notifySpy.fn(...args);
    if (notifySpy.shouldThrow) return Promise.reject(new Error("발송 실패(테스트)"));
    return Promise.resolve(notifySpy.result);
  },
}));

/**
 * 🔴 v2 판정 스텁 (2026-08-01).
 *
 * `1650cb4f`(결제된 주문을 go 가 자기 시계로 죽이지 못하게) 이후, 만료 보상은
 * **v2 에 물어봐서 terminal 로 확인됐을 때만** 진행한다. 통합 환경엔 v2 가 없어
 * 판정이 `unknown` 이 되고 라우트는 fail-closed 로 `compensation_deferred` 를 낸다.
 * 아래 세 보상 테스트는 그 가드가 아니라 **보상 기록 자체**를 보는 것이므로
 * v2 가 terminal 이라고 답한 상태를 만들어 준다.
 *
 * ⚠️ 이 파일은 그동안 조용히 전부 skip 돼 있었다(마이그 240 이 지운 `organizers`
 *    테이블을 아직 INSERT 하고 있었다). 그래서 위 동작 변경이 여기 반영되지 않았다.
 */
const v2Verdict = vi.hoisted(() => ({
  fn: vi.fn(async () => ({ kind: "terminal" as const, v2OrderId: "v2-stub", v2Status: "expired" })),
}));
vi.mock("@/lib/orders/v2-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orders/v2-authority")>()),
  askV2AboutOrder: v2Verdict.fn,
}));

import { POST, processPendingOrderWebhooks } from "@/app/api/internal/orders/state-changed/route";

const integration = process.env.RUN_INTEGRATION === "1";
const describeIntegration = describe.skipIf(!integration);
const secret = process.env.GO_WEBHOOK_SECRET ?? "audit-secret";
const accountId = crypto.randomUUID();
const eventId = crypto.randomUUID();
const seatMapId = crypto.randomUUID();
const deliveryIds: string[] = [];
const orderIds: string[] = [];

async function insertOrder(input: { expiresAt: string | null; status?: string; paymentStatus?: string; withSeat?: boolean; v2OrderId?: string }) {
  const pool = getPool();
  const orderId = crypto.randomUUID();
  const v2OrderId = input.v2OrderId ?? crypto.randomUUID();
  orderIds.push(orderId);
  await pool.query(
    `INSERT INTO orders
      (id, account_id, event_id, order_number, buyer_name, buyer_email, total_amount, paid_amount,
       refund_amount, status, payment_method, payment_status, expires_at, v2_order_id)
     VALUES ($1, $2, $3, $4, 'Webhook Buyer', $5, 10000, 0, 0, $6, 'toss', $7, $8, $9)`,
    [orderId, accountId, eventId, `AUDIT-${orderId.slice(0, 8)}`, `${orderId}@example.test`,
      input.status ?? "pending", input.paymentStatus ?? "pending", input.expiresAt, v2OrderId],
  );
  if (input.withSeat) {
    await pool.query(
      `INSERT INTO seats (id, account_id, seat_map_id, section, row, seat_number, status, reserved_order_id)
       VALUES ($1,$2,$3,'A','1',$4,'reserved',$5)`,
      [crypto.randomUUID(), accountId, seatMapId, orderId.slice(0, 6), orderId],
    );
  }
  return { orderId, v2OrderId };
}

async function sendConfirmed(v2OrderId: string, deliveryId = crypto.randomUUID()) {
  deliveryIds.push(deliveryId);
  const body = JSON.stringify({
    event: "order.payment.confirmed",
    delivery_id: deliveryId,
    timestamp: new Date().toISOString(),
    order_id: v2OrderId,
    data: { amount: 10000, method: "toss", payment_id: `payment-${deliveryId}` },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return POST(new NextRequest("http://localhost/api/internal/orders/state-changed", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-pickket-signature": `sha256=${signature}`,
      "x-pickket-timestamp": timestamp,
      "x-pickket-event": "order.payment.confirmed",
      "x-pickket-delivery-id": deliveryId,
    },
  }));
}

/**
 * 환불 전파를 보낸다 — 통지 멱등 표식(`orders.refund_notified_at`) 검증용.
 * `sendConfirmed` 와 같은 서명 규약.
 */
async function sendRefunded(
  v2OrderId: string,
  deliveryId = crypto.randomUUID(),
  data: Record<string, unknown> = { is_full_refund: true, refund_amount: 15000, total_refunded: 15000 },
) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    event: "order.refunded",
    delivery_id: deliveryId,
    timestamp,
    order_id: v2OrderId,
    data,
  });
  const signature = crypto
    .createHmac("sha256", process.env.GO_WEBHOOK_SECRET ?? "test-secret")
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return POST(new NextRequest("http://localhost/api/internal/orders/state-changed", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-pickket-signature": `sha256=${signature}`,
      "x-pickket-timestamp": timestamp,
      "x-pickket-event": "order.refunded",
      "x-pickket-delivery-id": deliveryId,
    },
  }));
}

describeIntegration("internal payment webhook expiry and ordering", () => {
  beforeAll(async () => {
    const pool = getPool();
    await pool.query("INSERT INTO accounts (id,name,slug,contact_email) VALUES ($1,'Webhook Audit',$2,$3)", [accountId, `audit-${accountId}`, `${accountId}@example.test`]);
    // 🔴 `organizers` 는 마이그 240(drop-organizers-event-schedules)에서 삭제됐다.
    //    이 테스트가 따라오지 않아 beforeAll 이 relation 없음으로 죽고 **전 케이스가
    //    조용히 skip** 되고 있었다(2026-08-01 발견). events.organizer_id 도 함께 정리한다.
    await pool.query(
      `INSERT INTO events (id,account_id,title,slug,starts_at,ends_at,status)
       VALUES ($1,$2,'Webhook Audit Event',$3,NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day 1 hour','live')`,
      [eventId, accountId, `audit-${eventId}`],
    );
    await pool.query(
      `INSERT INTO seat_maps (id,account_id,event_id,name,status) VALUES ($1,$2,$3,'Webhook Audit Map','published')`,
      [seatMapId, accountId, eventId],
    );
  });

  afterAll(async () => {
    const pool = getPool();
    if (deliveryIds.length > 0) {
      await pool.query("DELETE FROM inter_service_webhook_deliveries WHERE delivery_id = ANY($1::uuid[])", [deliveryIds]);
    }
    if (orderIds.length > 0) await pool.query("DELETE FROM payment_compensation_actions WHERE order_id = ANY($1::uuid[])", [orderIds]);
    await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    await pool.end();
  });

  it("rejects expired pending confirmation and records one compensation action", async () => {
    const pool = getPool();
    const { orderId, v2OrderId } = await insertOrder({ expiresAt: new Date(Date.now() - 60_000).toISOString(), withSeat: true });
    const result = await sendConfirmed(v2OrderId);
    const order = await pool.query("SELECT status, payment_status, paid_amount FROM orders WHERE id = $1", [orderId]);
    const compensation = await pool.query("SELECT status, requested_amount FROM payment_compensation_actions WHERE order_id = $1", [orderId]);
    const seat = await pool.query("SELECT status FROM seats WHERE reserved_order_id = $1", [orderId]);
    const audit = await pool.query("SELECT status FROM inter_service_webhook_deliveries WHERE delivery_id = $1", [deliveryIds.at(-1)]);

    expect(result.status).toBe(200);
    expect((await result.json()).data.status).toBe("expired_compensation_pending");
    expect(order.rows[0]).toMatchObject({ status: "expired", payment_status: "paid", paid_amount: "10000" });
    expect(compensation.rows).toEqual([{ status: "pending", requested_amount: "10000" }]);
    expect(seat.rows).toEqual([{ status: "reserved" }]);
    expect(audit.rows[0]?.status).toBe("processed");
  });

  it("completes a non-expired pending confirmation without compensation", async () => {
    const pool = getPool();
    const { orderId, v2OrderId } = await insertOrder({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const result = await sendConfirmed(v2OrderId);
    const order = await pool.query("SELECT status, payment_status FROM orders WHERE id = $1", [orderId]);
    const compensation = await pool.query("SELECT id FROM payment_compensation_actions WHERE order_id = $1", [orderId]);

    expect(result.status).toBe(200);
    expect((await result.json()).data.status).toBe("ok");
    expect(order.rows[0]).toEqual({ status: "completed", payment_status: "paid" });
    expect(compensation.rows).toHaveLength(0);
  });

  it("treats completed and refunded late confirmations as idempotent or stale", async () => {
    const pool = getPool();
    const completed = await insertOrder({ expiresAt: null, status: "completed", paymentStatus: "paid" });
    const completedResult = await sendConfirmed(completed.v2OrderId);
    expect(completedResult.status).toBe(200);
    expect((await completedResult.json()).data.status).toBe("ok");

    const refunded = await insertOrder({ expiresAt: null, status: "refunded", paymentStatus: "refunded" });
    const refundedResult = await sendConfirmed(refunded.v2OrderId);
    const row = await pool.query("SELECT status, payment_status FROM orders WHERE id = $1", [refunded.orderId]);
    const audit = await pool.query("SELECT status, error_message FROM inter_service_webhook_deliveries WHERE delivery_id = $1", [deliveryIds.at(-1)]);
    expect(refundedResult.status).toBe(200);
    expect((await refundedResult.json()).data.status).toBe("ignored_stale");
    expect(row.rows[0]).toEqual({ status: "refunded", payment_status: "refunded" });
    expect(audit.rows[0]).toEqual({ status: "ignored", error_message: "stale_event" });
  });

  it("serializes two confirmations for an expired order into one compensation row", async () => {
    const pool = getPool();
    const { orderId, v2OrderId } = await insertOrder({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const firstDelivery = crypto.randomUUID();
    const secondDelivery = crypto.randomUUID();
    const [first, second] = await Promise.all([
      sendConfirmed(v2OrderId, firstDelivery),
      sendConfirmed(v2OrderId, secondDelivery),
    ]);
    const compensation = await pool.query("SELECT count(*)::int AS count FROM payment_compensation_actions WHERE order_id = $1", [orderId]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(compensation.rows[0]?.count).toBe(1);
  });

  it("does not reclaim a seat that was reassigned before a late confirmation", async () => {
    const pool = getPool();
    const expired = await insertOrder({ expiresAt: new Date(Date.now() - 60_000).toISOString(), withSeat: true });
    const replacement = await insertOrder({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "completed",
      paymentStatus: "paid",
    });
    await pool.query(
      `UPDATE seats SET status = 'reserved', reserved_order_id = $2, updated_at = NOW()
         WHERE reserved_order_id = $1`,
      [expired.orderId, replacement.orderId],
    );

    const result = await sendConfirmed(expired.v2OrderId);
    const order = await pool.query("SELECT status, payment_status FROM orders WHERE id = $1", [expired.orderId]);
    const seat = await pool.query("SELECT status, reserved_order_id FROM seats WHERE reserved_order_id = $1", [replacement.orderId]);

    expect(result.status).toBe(200);
    expect((await result.json()).data.status).toBe("expired_compensation_pending");
    expect(order.rows[0]).toEqual({ status: "expired", payment_status: "paid" });
    expect(seat.rows).toEqual([{ status: "reserved", reserved_order_id: replacement.orderId }]);
  });

  it("keeps a missing-order delivery pending and processes it after the order appears", async () => {
    const pool = getPool();
    const v2OrderId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    const first = await sendConfirmed(v2OrderId, deliveryId);
    const pending = await pool.query("SELECT status, retry_count FROM inter_service_webhook_deliveries WHERE delivery_id = $1", [deliveryId]);
    expect(first.status).toBe(202);
    expect((await first.json()).data.status).toBe("pending_order");
    expect(pending.rows[0]).toMatchObject({ status: "pending", retry_count: 0 });

    // 같은 delivery는 pending 상태에서 duplicate/processed로 덮이지 않는다.
    const replay = await sendConfirmed(v2OrderId, deliveryId);
    expect(replay.status).toBe(202);
    expect((await replay.json()).data.status).toBe("pending");

    const { orderId } = await insertOrder({ expiresAt: new Date(Date.now() + 60_000).toISOString(), v2OrderId });
    await pool.query("UPDATE inter_service_webhook_deliveries SET next_attempt_at = NOW() WHERE delivery_id = $1", [deliveryId]);
    const summary = await processPendingOrderWebhooks(10);
    const order = await pool.query("SELECT status, payment_status FROM orders WHERE id = $1", [orderId]);
    const processed = await pool.query("SELECT status, retry_count FROM inter_service_webhook_deliveries WHERE delivery_id = $1", [deliveryId]);
    expect(summary.processed).toBe(1);
    expect(order.rows[0]).toEqual({ status: "completed", payment_status: "paid" });
    expect(processed.rows[0]).toMatchObject({ status: "processed", retry_count: 1 });
  });

  it("moves a permanently missing order to dead-letter after the retry limit", async () => {
    const pool = getPool();
    const deliveryId = crypto.randomUUID();
    deliveryIds.push(deliveryId);
    await pool.query(
      `INSERT INTO inter_service_webhook_deliveries
        (delivery_id,event,source,direction,signature,timestamp_sent,payload,status,retry_count,next_attempt_at,created_at)
       VALUES ($1,'order.payment.confirmed','v2','inbound','audit',NOW(),'{}'::jsonb,'pending',8,NOW(),NOW())`,
      [deliveryId],
    );
    const summary = await processPendingOrderWebhooks(10);
    const row = await pool.query("SELECT status, error_message FROM inter_service_webhook_deliveries WHERE delivery_id = $1", [deliveryId]);
    expect(summary.deadLettered).toBe(1);
    expect(row.rows[0]).toEqual({ status: "dead_lettered", error_message: "order_not_found_max_retries" });
  });

  /**
   * 🔴 환불완료 통지 멱등 (2026-08-01).
   *
   * 즉시환불은 go 주문을 **먼저** refunded 로 갱신하므로, 뒤따라오는 전파는 **항상**
   * `idempotent` 로 도착한다 — 그게 정상 경로다. 그래서 `via` 로 중복을 판정하면
   * **알림톡이 영영 안 나간다.** 멱등은 알림 자체(`orders.refund_notified_at`)에 건다.
   */
  it("🔴 환불 통지는 첫 도착에만 표식되고 재도착엔 건너뛴다", async () => {
    const pool = getPool();
    // 즉시환불이 이미 갱신한 상태를 재현 — 전파는 idempotent 로 도착한다
    const order = await insertOrder({ expiresAt: null, status: "refunded", paymentStatus: "refunded" });
    notifySpy.fn.mockClear();

    const first = await sendRefunded(order.v2OrderId);
    expect(first.status).toBe(200);
    const afterFirst = await pool.query<{ refundNotifiedAt: Date | null }>(
      `SELECT refund_notified_at AS "refundNotifiedAt" FROM orders WHERE id = $1`,
      [order.orderId],
    );
    // 🔴 이미 refunded(=idempotent)여도 통지 표식이 찍혀야 한다 — 안 찍히면 알림이 안 나간 것
    expect(afterFirst.rows[0].refundNotifiedAt).not.toBeNull();
    const firstAt = afterFirst.rows[0].refundNotifiedAt;

    // 🔴 다른 delivery_id 로 재도착 — **선점에 실패해 발송을 건너뛰어야** 한다.
    //    ⚠️ 처음엔 "표식 시각이 안 바뀌었는가" 만 봤는데, 선점 조건(`IS NULL`)을 지워도
    //       NOW() 가 거의 같아 통과했다(뮤테이션 2종 생존). 표식이 아니라 **행동**을 본다.
    //       표식을 미리 지워두면, 선점이 살아 있는 구현은 다시 찍고(=발송) 죽은 구현은
    //       구분이 안 된다 — 그래서 "이미 찍혀 있을 때 건너뛰는가" 를 직접 검사한다.
    const before = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM orders WHERE id = $1 AND refund_notified_at IS NOT NULL`,
      [order.orderId],
    );
    expect(before.rows[0].n).toBe("1");   // 첫 도착으로 이미 선점된 상태

    // 표식을 과거 시각으로 고정해 두면, 재발송한 구현은 NOW() 로 **덮어쓴다**.
    const pinned = new Date(Date.now() - 60_000);
    await pool.query(`UPDATE orders SET refund_notified_at = $2 WHERE id = $1`, [
      order.orderId, pinned,
    ]);

    const second = await sendRefunded(order.v2OrderId);
    expect(second.status).toBe(200);
    const afterSecond = await pool.query<{ refundNotifiedAt: Date | null }>(
      `SELECT refund_notified_at AS "refundNotifiedAt" FROM orders WHERE id = $1`,
      [order.orderId],
    );
    // 🔴 선점이 살아 있으면 0행 갱신 → 고정해둔 과거 시각이 **그대로** 남는다.
    //    선점 조건을 지우면 NOW() 로 덮어써서 이 검사가 죽는다.
    expect(afterSecond.rows[0].refundNotifiedAt?.getTime()).toBe(pinned.getTime());
    expect(afterSecond.rows[0].refundNotifiedAt?.getTime()).not.toBe(firstAt?.getTime());
    // 🔴 그리고 **발송 자체가 한 번뿐**이어야 한다. 표식만 보면 "선점 결과를 무시하고
    //    강행" 하는 변경을 못 잡는다(뮤테이션 생존으로 확인).
    expect(notifySpy.fn).toHaveBeenCalledTimes(1);
  });

  it("🔴 발송이 실패하면 표식이 풀린다 — 안 풀면 구매자가 영영 못 받는다", async () => {
    const pool = getPool();
    const order = await insertOrder({ expiresAt: null, status: "refunded", paymentStatus: "refunded" });
    notifySpy.fn.mockClear();
    notifySpy.shouldThrow = true;
    try {
      const res = await sendRefunded(order.v2OrderId);
      expect(res.status).toBe(200);   // 알림 실패가 웹훅 처리를 깨뜨리지는 않는다
      expect(notifySpy.fn).toHaveBeenCalledTimes(1);
      const row = await pool.query<{ refundNotifiedAt: Date | null }>(
        `SELECT refund_notified_at AS "refundNotifiedAt" FROM orders WHERE id = $1`,
        [order.orderId],
      );
      // 🔴 실패했으니 표식이 NULL 로 되돌아와야 한다. 안 되돌리면 다음 전달도
      //    "이미 보냈다" 로 건너뛰어 구매자가 영영 못 받는다.
      expect(row.rows[0].refundNotifiedAt).toBeNull();
    } finally {
      notifySpy.shouldThrow = false;
    }

    // 되돌아왔으니 다음 전달은 다시 시도한다
    notifySpy.fn.mockClear();
    await sendRefunded(order.v2OrderId);
    expect(notifySpy.fn).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **발송 실패는 예외가 아니라 반환값으로 온다** (2026-08-01 배포 검수).
   *
   * `notifyRefundConfirm` → `fanout` 은 채널별 실패를 삼키고 `{attempted, failed}` 만
   * 돌려준다. 따라서 위 "예외를 던지면 표식이 풀린다" 테스트는 **실제로는 도달하지 않는
   * 경로**를 검증하고 있었다 — 목이 reject 하도록 만들었기 때문이다.
   *
   * 전 채널이 실패했는데 표식이 남으면 **다음 전달도 "이미 보냈다" 로 건너뛰어
   * 구매자가 영영 못 받는다.** 선점·해제 구조가 통째로 무력해진다.
   */
  it("🔴 전 채널 실패(예외 아님)면 표식이 풀린다 — fanout 은 throw 하지 않는다", async () => {
    const pool = getPool();
    const order = await insertOrder({ expiresAt: null, status: "refunded", paymentStatus: "refunded" });
    notifySpy.fn.mockClear();
    const prev = notifySpy.result;
    notifySpy.result = { attempted: 2, failed: 2 };   // 이메일·알림톡 둘 다 실패
    try {
      const res = await sendRefunded(order.v2OrderId);
      expect(res.status).toBe(200);
      expect(notifySpy.fn).toHaveBeenCalledTimes(1);
      const row = await pool.query<{ refundNotifiedAt: Date | null }>(
        `SELECT refund_notified_at AS "refundNotifiedAt" FROM orders WHERE id = $1`,
        [order.orderId],
      );
      expect(row.rows[0].refundNotifiedAt, "전 채널 실패인데 표식이 남았다").toBeNull();
    } finally {
      notifySpy.result = prev;
    }

    // 풀렸으니 다음 전달은 다시 시도한다
    notifySpy.fn.mockClear();
    await sendRefunded(order.v2OrderId);
    expect(notifySpy.fn).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ **부분 실패는 성공이다.** 알림톡 템플릿 승인 전에는 카카오 채널이 항상 실패한다.
   *    그때 표식을 풀면 다음 전달마다 **이메일이 재발송**된다 — 손님이 같은 메일을
   *    계속 받는다. 한 채널이라도 나갔으면 통지는 성립한 것으로 본다.
   */
  it("🔴 부분 실패(알림톡만 실패)면 표식을 유지한다 — 안 그러면 이메일이 재발송된다", async () => {
    const pool = getPool();
    const order = await insertOrder({ expiresAt: null, status: "refunded", paymentStatus: "refunded" });
    notifySpy.fn.mockClear();
    const prev = notifySpy.result;
    notifySpy.result = { attempted: 2, failed: 1 };   // 이메일 성공 · 알림톡 실패(승인 전 상태)
    try {
      await sendRefunded(order.v2OrderId);
      const row = await pool.query<{ refundNotifiedAt: Date | null }>(
        `SELECT refund_notified_at AS "refundNotifiedAt" FROM orders WHERE id = $1`,
        [order.orderId],
      );
      expect(row.rows[0].refundNotifiedAt, "부분 실패인데 표식이 풀렸다 — 이메일이 재발송된다").not.toBeNull();

      // 재도착해도 다시 보내지 않는다
      notifySpy.fn.mockClear();
      await sendRefunded(order.v2OrderId);
      expect(notifySpy.fn).not.toHaveBeenCalled();
    } finally {
      notifySpy.result = prev;
    }
  });

  it("🔴 원장에는 건별이 아니라 **누계**가 적힌다", async () => {
    const pool = getPool();
    const order = await insertOrder({ expiresAt: null, status: "completed", paymentStatus: "paid" });
    // ⚠️ insertOrder 는 paid_amount=0 으로 만든다. 원장 UPDATE 가
    //    LEAST(..., paid_amount) 로 클램프하므로 0 이면 무엇을 보내도 0 이 된다
    //    (첫 시도에서 이걸로 실패했다). 실제 결제액을 채워야 계약을 볼 수 있다.
    await pool.query(`UPDATE orders SET paid_amount = 30000, total_amount = 30000 WHERE id = $1`, [
      order.orderId,
    ]);
    // 이번 건 10,000 · 누계 25,000 (부분환불 2회째를 재현)
    await sendRefunded(order.v2OrderId, crypto.randomUUID(), {
      is_full_refund: false, refund_amount: 10000, total_refunded: 25000,
    });
    const row = await pool.query<{ refundAmount: string }>(
      `SELECT refund_amount AS "refundAmount" FROM orders WHERE id = $1`,
      [order.orderId],
    );
    // 🔴 건별(10,000)이 아니라 누계(25,000)여야 한다.
    //    건별을 쓰면 부분환불 2회째에 원장 누계가 **줄어든다**.
    expect(Number(row.rows[0].refundAmount)).toBe(25000);
  });
});

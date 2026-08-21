import { cookies } from "next/headers";
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { notifyNewOrder, notifySoldOut } from "@/lib/notifications/create";
import { transitionAttendees } from "@/lib/state-machine/attendee-state-machine";
import { transitionOrder } from "@/lib/state-machine/order-state-machine";
import { tossProvider } from "@/lib/payment/toss";
import { recordPaymentConfirmOutbox } from "@/lib/payment/confirm-v2";
import { dispatchWebhook } from "@/lib/webhook/dispatcher";
import { resolveSoldOutProductsForOrder } from "@/lib/notification/sold-out";

const schema = z.object({
  paymentKey: z.string().min(1),
  orderId: z.string().uuid(),
  amount: z.number().nonnegative(),
});

async function confirmHandler(request: Request) {
  try {
    const body = schema.parse(await request.json());

    // P1: 소유권 검증 — checkout/initiate 가 발급한 쿠키와 orderId 일치 확인.
    // 임의 주문 승인 시도 + 상태 오라클 차단. (감사 P1-2)
    const cookieStore = await cookies();
    if (cookieStore.get("pickket_last_order")?.value !== body.orderId) {
      return errorResponse("주문 소유권을 확인할 수 없습니다", 403);
    }

    const pool = getPool();

    // 결제 승인 전 DB 금액 검증 — 변조 방지
    const orderCheck = await pool.query<{ total_amount: string; status: string }>(
      "SELECT total_amount, status FROM orders WHERE id = $1 LIMIT 1",
      [body.orderId],
    );
    if (orderCheck.rows.length === 0) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }
    const dbAmount = Number(orderCheck.rows[0].total_amount);
    if (body.amount !== dbAmount) {
      return errorResponse("결제 금액이 주문 금액과 일치하지 않습니다", 400);
    }
    if (orderCheck.rows[0].status !== "pending") {
      // 재시도 멱등: 승인 완료 후 응답이 유실돼 클라이언트가 confirm 을 재호출하는 케이스.
      // completed 주문의 재확인은 성공으로 응답해야 사용자가 실패 화면에 갇히지 않는다.
      if (orderCheck.rows[0].status === "completed") {
        return successResponse({ success: true, paymentKey: body.paymentKey, alreadyCompleted: true });
      }
      return errorResponse("이미 처리된 주문입니다", 409);
    }

    // P0-3(레벨2 재감사): PG 승인 전 durable intent 기록 + 시도별 ledger.
    // tossProvider.confirm(=PG 캡처)이 성공한 뒤 go 트랜잭션(전이/attendee/outbox)이 실패하면
    // 과거엔 Toss=DONE·go=pending·outbox 없음 = reconcile 이 잡을 단서가 전무한 orphan 이었다.
    //
    // P1(레벨2 재감사) — payment_reference CAS + 시도별 ledger:
    //   과거엔 payment_reference 를 무조건 덮어쓰고 rowCount 확인 없이 외부 PG confirm 을 실행했다.
    //   동시 재시도(같은 orderId·다른 paymentKey)면 첫 결제키가 덮어써져 추적 불가였다. 이제:
    //     (1) 모든 시도 키를 payment_attempts 에 durable 기록(멱등: (order_id,payment_key) UNIQUE).
    //         → orphan scanner 가 덮어써진 이전 키까지 시도별로 조회·회수할 수 있다.
    //     (2) orders.payment_reference 는 CAS(IS NULL OR = 요청키)로만 선점. rowCount=0(=다른 키가
    //         이미 선점)이면 **외부 PG confirm 을 실행하지 않고** 409 로 거절한다. → 한 주문에 두
    //         paymentKey 로 동시 캡처가 걸리는 이중결제 자체를 최대한 차단(첫 키만 승인 진행).
    await pool.query(
      `INSERT INTO payment_attempts (order_id, provider, payment_key, amount, status)
       VALUES ($1, 'toss', $2, GREATEST($3, 0), 'pending')
       ON CONFLICT (order_id, payment_key) DO UPDATE SET updated_at = NOW()`,
      [body.orderId, body.paymentKey, body.amount],
    );

    const cas = await pool.query(
      `UPDATE orders
          SET payment_method = 'toss', payment_reference = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
          AND (payment_reference IS NULL OR payment_reference = $2)`,
      [body.orderId, body.paymentKey],
    );
    if ((cas.rowCount ?? 0) === 0) {
      // 다른 paymentKey 가 이미 이 주문의 결제참조를 선점(동시 재시도 경합). 외부 PG confirm 금지.
      // 이 시도 키는 ledger 에 pending 으로 남아, 만약 이 키로도 캡처가 발생했다면 orphan scanner 가
      // 회수한다(이중결제 안전망). 사용자에겐 경합 결과를 409 로 알린다.
      return errorResponse("이미 처리 중인 결제 요청입니다", 409);
    }
    // 이 키가 결제참조를 선점(정본 결제) — ledger 상태를 won 으로 마킹(추적용).
    await pool.query(
      `UPDATE payment_attempts SET status = 'won', updated_at = NOW()
        WHERE order_id = $1 AND payment_key = $2 AND status = 'pending'`,
      [body.orderId, body.paymentKey],
    );

    const result = await tossProvider.confirm(body);

    // 가상계좌 발급·입금대기: 주문을 pending 으로 유지하고 결제수단/참조만 기록한다.
    // 실입금 확정은 DEPOSIT_CALLBACK 웹훅에서 조회검증 후 수행(자가확정 금지). (감사 P0-F 동일 원칙)
    if (result.pending) {
      await pool.query(
        `
          UPDATE orders
          SET payment_method = 'toss', payment_status = 'pending',
              payment_reference = $2, updated_at = NOW()
          WHERE id = $1 AND status = 'pending'
        `,
        [body.orderId, result.paymentKey],
      );
      return successResponse({ ...result, awaitingDeposit: true });
    }

    const client = await pool.connect();
    let shouldNotify = false;
    let outboxPending = false;

    try {
      await client.query("BEGIN");
      const transitioned = await transitionOrder(client, body.orderId, "pending", "completed");
      shouldNotify = transitioned;

      if (!transitioned) {
        const currentOrder = await client.query<{ status: string }>(
          `
            SELECT status
            FROM orders
            WHERE id = $1
            LIMIT 1
          `,
          [body.orderId],
        );

        if (currentOrder.rows.length === 0) {
          await client.query("ROLLBACK");
          return errorResponse(ERR.NOT_FOUND, 404);
        }

        if (currentOrder.rows[0]?.status !== "completed") {
          await client.query("ROLLBACK");
          return errorResponse("이미 처리된 주문입니다", 409);
        }
      }

      await client.query(
        `
          UPDATE orders
          SET
            payment_method = 'toss',
            payment_status = 'paid',
            paid_amount = $2,
            payment_reference = $3,
            updated_at = NOW()
          WHERE id = $1
        `,
        [body.orderId, body.amount, result.paymentKey],
      );

      // pending→completed 전이가 이 요청에서 성공한 경우에만 attendee 확정 + v2 write-through.
      // transitionAttendees 누락 시 카드결제 후 attendee 가 pending 으로 남아 체크인/QR 불가. (감사 P1-1)
      // PG 는 이미 승인됨 → v2 실패해도 흐름 차단하지 않음(헬퍼가 로깅+reconcile, 멱등).
      if (transitioned) {
        await transitionAttendees(client, body.orderId, "pending", "confirmed");
        // P0 재배선: pending outbox 행만 이 트랜잭션에 원자 기록(외부 v2 호출 없음).
        // 실제 v2 confirm 은 COMMIT 후 워커/cron 이 트랜잭션 밖에서 수행 → 역 split-brain 불가.
        const outboxResult = await recordPaymentConfirmOutbox(client, body.orderId, { amount: body.amount });
        outboxPending = outboxResult.pending;
      }

      // 정상 PG 승인과 go 완료 투영이 같은 트랜잭션에서 확정됐으므로 이 paymentKey의 ledger도
      // terminal(settled)로 닫는다. pending/won 잔류는 orphan 스캐너의 미정산 후보 의미를 오염시킨다.
      await client.query(
        `UPDATE payment_attempts
            SET status = 'settled', provider_status = 'DONE',
                last_looked_up_at = NOW(), updated_at = NOW()
          WHERE order_id = $1 AND payment_key = $2
            AND status IN ('pending', 'won', 'captured')`,
        [body.orderId, body.paymentKey],
      );

      await client.query("COMMIT");
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // COMMIT 후: pending outbox 행이 있으면 재조정 워커 트리거(v2 confirm 은 트랜잭션 밖·커밋 후).
    // enqueue 실패는 cron 이중 안전망이 drain. v2OrderId 없음(NICE/레거시)=outbox 미기록이라 스킵.
    if (shouldNotify && outboxPending) {
      const { enqueuePaymentConfirm } = await import("@/lib/queue/payment-confirm-queue");
      await enqueuePaymentConfirm(body.orderId);
    }

    // 레벨2 read-flip: 매진 상품은 v2 티어(capacity vs sold_count)로 산출 — go order_items/products.stock 폐기.
    const [orderResult, soldOutProducts] = await Promise.all([
      pool.query<{ accountId: string; eventId: string; orderNumber: string; totalAmount: number }>(
        `
          SELECT
            account_id AS "accountId",
            event_id AS "eventId",
            order_number AS "orderNumber",
            total_amount AS "totalAmount"
          FROM orders
          WHERE id = $1
          LIMIT 1
        `,
        [body.orderId],
      ),
      resolveSoldOutProductsForOrder(body.orderId),
    ]);

    const order = orderResult.rows[0];
    if (order && shouldNotify) {
      await notifyNewOrder(order.accountId, order.eventId, order.orderNumber, Number(order.totalAmount));
      await Promise.all(
        soldOutProducts.map((product) =>
          notifySoldOut(product.accountId, product.eventId, product.productName),
        ),
      );
      // 주문 완료 웹훅(체크인/외부연동 트리거). 실패해도 결제완료 응답을 막지 않음. (감사 P1-1)
      try {
        await dispatchWebhook("order.completed", { ...order, orderId: body.orderId });
      } catch {
        /* dispatcher 자체 로깅 — 결제완료 흐름 비차단 */
      }
    }

    return successResponse(result);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 10,
  windowMs: 60_000,
  keyPrefix: "payment:toss:confirm",
})(confirmHandler);

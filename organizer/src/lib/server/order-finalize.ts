import { getPool } from "@/lib/db/pool";
import { notifyNewOrder, notifySoldOut } from "@/lib/notifications/create";
import { sendPurchaseConfirm } from "@/lib/notification/purchase-confirm-sender";
import { recordPaymentConfirmOutbox } from "@/lib/payment/confirm-v2";
import { transitionAttendees } from "@/lib/state-machine/attendee-state-machine";
import { transitionOrder } from "@/lib/state-machine/order-state-machine";
import { dispatchWebhook } from "@/lib/webhook/dispatcher";
import { resolveSoldOutProductsForOrder } from "@/lib/notification/sold-out";

type CompletedOrderRow = {
  id: string;
  status: string;
  accountId: string;
  eventId: string;
  orderNumber: string;
  totalAmount: number;
};

/** 결제확정 처리 결과. 호출측(HTTP 라우트)이 각자 응답으로 매핑한다. */
export type FinalizeOutcome =
  | { kind: "completed"; order: CompletedOrderRow }
  | { kind: "already_completed"; order: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "conflict" }
  /**
   * @deprecated 레벨2 컷오버 T1 — **생산자 없음**. go 좌석 만료검증 경로가 사라지면서
   * 이 결과를 반환하는 코드가 없어졌다(좌석 SOLD 확정은 v2 createOrder 가 소유).
   * 호출부(checkout/complete·입금확정)의 분기는 호환을 위해 그대로 두고 타입만 남긴다.
   */
  | { kind: "seat_expired" };

/**
 * 주문 결제확정(공용): pending → completed 전이 + 결제액 확정 + 참석자 confirmed +
 * v2 결제확정 outbox 기록 + 후속 알림/웹훅.
 *
 * 두 진입점에서 재사용된다:
 *  1) checkout/complete — 온라인 PG 승인 or 데모/E2E mock 의 self-complete
 *  2) 주최자 입금확정 API — 무통장입금(bank_transfer/offline) 실입금 확인 후 수동 확정
 *
 * ⚠️ 무통장입금은 구매자 self-complete 로 확정되면 안 된다(실입금 0원으로 유효티켓 + v2 매출
 *    위조 가능 — 감사 P0-F). 따라서 checkout/complete 는 offline 계열을 입금대기로 남기고
 *    이 함수를 호출하지 않으며, 오직 주최자 입금확정 경로에서만 offline 주문을 확정한다.
 *
 * 좌석: 레벨2 컷오버 T1 이후 go 는 좌석을 소유하지 않는다. 좌석 SOLD 확정·만료는 전부
 * v2(createOrder / inventory hold TTL·reaper)가 처리하므로 이 함수는 좌석을 건드리지 않는다.
 */
export async function finalizeOrderPayment(
  orderId: string,
  paymentMethod: string,
): Promise<FinalizeOutcome> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transitionSucceeded = await transitionOrder(client, orderId, "pending", "completed");

    if (!transitionSucceeded) {
      const existingOrderResult = await client.query<{
        id: string;
        status: string;
        eventId: string;
        orderNumber: string;
        totalAmount: number;
      }>(
        `
          SELECT
            id,
            status,
            event_id AS "eventId",
            order_number AS "orderNumber",
            total_amount AS "totalAmount"
          FROM orders
          WHERE id = $1
          LIMIT 1
        `,
        [orderId],
      );

      if (existingOrderResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return { kind: "not_found" };
      }

      const existingOrder = existingOrderResult.rows[0]!;
      if (existingOrder.status === "completed") {
        await client.query("COMMIT");
        return { kind: "already_completed", order: existingOrder };
      }

      await client.query("ROLLBACK");
      return { kind: "conflict" };
    }

    const orderResult = await client.query(
      `
        UPDATE orders
        SET
          payment_method = $2,
          payment_status = 'paid',
          paid_amount = total_amount,
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, status, account_id AS "accountId", event_id AS "eventId", order_number AS "orderNumber", total_amount AS "totalAmount"
      `,
      [orderId, paymentMethod],
    );

    await transitionAttendees(client, orderId, "pending", "confirmed");

    // ── 레벨2 컷오버 T1 — go 좌석 sold 처리 블록 제거(죽은 경로) ──
    //
    // 여기 있던 코드는 `SELECT ... FROM seats WHERE reserved_order_id = $1 FOR UPDATE` 로
    // 주문 좌석을 잠그고 (a) 새 시스템이면 verifyAndMarkSold, (b) 아니면
    // `UPDATE seats SET status='sold' WHERE status='reserved'` 를 했다. 두 갈래 모두 **이미 죽어
    // 있었다**:
    //   1. `reserved_order_id` 는 코드베이스 어디에서도 write 되지 않는다(빅뱅 flip 때 markReserved/
    //      markSold 가 폐기되며 write 경로 소멸 — grep 결과 read 3곳뿐). → 이 SELECT 는 항상 0행.
    //   2. 설령 행이 있어도 `hold_id`/`held_by` 역시 아무도 쓰지 않아 (a)는 성립 불가, (b)의
    //      `status='reserved'` 도 세팅하는 곳이 없다.
    //   3. T1 이후엔 go `seats` 자체가 항상 빈 테이블이다(빌더 write 경로 소멸).
    //
    // 좌석 SOLD 확정의 정본은 **v2 createOrder**(주문 생성 시 seat_ids+hold_id 로 원자 확정)이며,
    // 레거시 hold→confirm 경로는 seatRepo.confirmHold(v2 /inventory/confirm, 멱등)가 담당한다.
    // → go 가 좌석을 sold 로 마킹할 경로는 존재하지 않는다.
    //
    // ⚠️ 이에 딸려 있던 "결제완료 후 좌석 홀드 만료 race" 보상(refund_requests + 환불 보상큐)도
    //    함께 사라진다. 그 race 는 구조적으로 발생할 수 없다: 좌석은 주문 생성 시점에 v2 에서
    //    SOLD 로 확정되고(만료 대상이 아님), 홀드가 그전에 만료됐다면 createOrder 가 4xx 로
    //    실패해 애초에 pending 주문이 만들어지지 않는다. 보상 인프라
    //    (payment_compensation_actions·워커·manual_review)는 다른 트리거들이 계속 쓰므로 그대로다.
    //    FinalizeOutcome 의 "seat_expired" 변형도 호출부 호환을 위해 타입에는 남겨둔다(생산자 없음).

    // B1(P0 재배선): 결제완료 → v2 결제확정을 위한 **pending outbox 행만** 이 트랜잭션에 기록.
    // transitionOrder(pending→completed) 성공 직후, 같은 트랜잭션(client) 에 원자 커밋된다.
    // 외부 v2 confirm 은 여기서 하지 않는다(원자화 불가 → 역 split-brain 방지) — COMMIT 후
    // 워커/cron 이 pending 행을 클레임해 멱등키로 수행한다.
    const outboxResult = await recordPaymentConfirmOutbox(client, orderId, {
      amount: Number(orderResult.rows[0]?.totalAmount ?? 0) || undefined,
    });

    await client.query("COMMIT");

    // COMMIT 후: pending outbox 행이 있으면 재조정 워커 트리거(v2 confirm 은 트랜잭션 밖·커밋 후).
    // v2OrderId 없음(레거시/NICE)=outbox 미기록이라 트리거 불필요. enqueue 실패는 cron 이중 안전망.
    if (outboxResult.pending) {
      const { enqueuePaymentConfirm } = await import("@/lib/queue/payment-confirm-queue");
      await enqueuePaymentConfirm(orderId);
    }

    // 레벨2 read-flip: 매진 상품은 v2 티어(capacity vs sold_count)로 산출 — go order_items/products.stock 폐기.
    const soldOutProducts = await resolveSoldOutProductsForOrder(orderId);

    // 후속 알림/웹훅은 COMMIT 후 실행. 실패해도 결제 완료 결과를 망가뜨리면 안 됨.
    try {
      await notifyNewOrder(
        String(orderResult.rows[0]?.accountId),
        String(orderResult.rows[0]?.eventId),
        String(orderResult.rows[0]?.orderNumber),
        Number(orderResult.rows[0]?.totalAmount ?? 0),
      );
    } catch (notifErr) {
      console.error("[order-finalize] notifyNewOrder failed", notifErr);
    }
    // 구매자 알림(정보성) — 구매완료 이메일/알림톡. best-effort(결제 결과 안 깨짐).
    // W2-ORD: 옛 `JOIN events e` 제거 — 행사 제목/일시 정본은 v2 다. go orders 는 구매자
    //   연락처·주문번호 앵커라 유지(§4 참조). 알림은 COMMIT 후 best-effort 이므로 v2 조회
    //   실패 시 결제 결과에 영향 없이 알림만 생략된다.
    try {
      const b = await pool.query<{
        accountId: string; eventId: string; orderNumber: string; v2OrderId: string | null;
        email: string | null; phone: string | null; name: string; ticketCount: string;
      }>(
        `SELECT o.account_id AS "accountId", o.event_id AS "eventId", o.order_number AS "orderNumber",
                o.v2_order_id AS "v2OrderId",
                o.buyer_email AS email, o.buyer_phone AS phone, o.buyer_name AS name,
                (SELECT COUNT(*) FROM attendees a WHERE a.order_id = o.id) AS "ticketCount"
         FROM orders o WHERE o.id = $1`,
        [orderId],
      );
      const r = b.rows[0];
      if (r) {
        // 발송 규칙(티켓번호 파생·열람가능 상태 확인·링크만료·폴백 금지)은
        // `purchase-confirm-sender` 한 곳에 있다. 여기서 다시 구현하면 카드 경로처럼
        // 인자가 갈라져 **버튼 없는 발송 → 카카오 3027 거부**가 재현된다.
        const result = await sendPurchaseConfirm({
          accountId: r.accountId, eventId: r.eventId, orderNumber: r.orderNumber,
          v2OrderId: r.v2OrderId, email: r.email, phone: r.phone, name: r.name,
          ticketCount: Number(r.ticketCount ?? 0),
        });
        if (!result.sent) {
          console.warn("[order-finalize] 구매확정 알림 미발송", result.reason);
        }
      }
    } catch (buyerErr) {
      console.error("[order-finalize] 구매확정 알림 실패", buyerErr);
    }
    try {
      await Promise.all(
        soldOutProducts.map((product) =>
          notifySoldOut(product.accountId, product.eventId, product.productName),
        ),
      );
    } catch (soldErr) {
      console.error("[order-finalize] notifySoldOut failed", soldErr);
    }
    try {
      await dispatchWebhook("order.completed", orderResult.rows[0]);
    } catch (whErr) {
      console.error("[order-finalize] webhook dispatch failed", whErr);
    }

    return { kind: "completed", order: orderResult.rows[0] as CompletedOrderRow };
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

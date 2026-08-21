/**
 * 결제됐는데 go 앵커가 뒤처진 주문을 v2 기준으로 되돌린다.
 *
 * ## 🔴 왜 (2026-07-31 실사고)
 * v2→go 결제확정 전파가 **한 번도 도달한 적이 없었다**. 그 결과 카드 결제 주문이
 * go 에서 `pending` 으로 남았고, 15분 뒤 만료 크론이 `expired` + 참석자 `cancelled`
 * 로 만들었다. 같은 상황에서 뒤늦게 전파가 도착하면 `state-changed` 가 그것을
 * "만료된 주문에 결제가 왔다" 로 읽어 **자동 전액환불 큐**에 넣는다.
 *
 * ## 이 모듈이 유일한 복구 경로다
 * 두 곳이 같은 함수를 쓴다 — **분기가 갈리면 한쪽만 고쳐진다**:
 *   · `state-changed` (전파가 뒤늦게 도착했을 때)
 *   · 대사 크론 (전파가 영영 안 왔을 때)
 *
 * ## 되돌리는 범위
 * 주문 상태 하나가 아니다. 상태만 고치면 **알림톡은 영영 안 나가고**, 참석자는
 * `cancelled` 로 남아 공지·리마인더 세그먼트에서 계속 빠진다.
 *   ① `orders.status → completed` + `expires_at` 해제(재발 차단)
 *   ② 결제 필드 투영(`payment_status/paid_amount/payment_method/payment_reference`)
 *   ③ 참석자 복원 — `cancelled` 였던 것만. **`checked_in` 은 절대 건드리지 않는다**
 *   ④ 대기 중인 보상환불 큐 취소 — 남겨두면 크론이 정당한 결제를 환불한다
 *
 * ⚠️ 알림톡 발송은 **여기서 하지 않는다**. 이 함수는 트랜잭션 안에서 돌고, 발송은
 *    커밋 후에 나가야 한다(롤백되면 "취소된 결제" 통지가 나간다). 호출자가
 *    반환된 `shouldNotify` 를 보고 커밋 뒤에 보낸다.
 */
import type { PoolClient } from "pg";
import { logger } from "@/lib/logger";
import { repairOrderToPaid } from "@/lib/state-machine/order-state-machine";

export interface RepairPaymentFacts {
  /** v2 가 보고한 상태 — repair 의 유일한 근거. */
  v2Status: string;
  v2OrderId: string | null;
  amount?: number | null;
  method?: string | null;
  paymentReference?: string | null;
}

export interface RepairOutcome {
  repaired: boolean;
  /** 무엇에서 되돌렸나 — `expired` 면 만료 크론이 이미 훑고 간 것이다. */
  from?: string;
  attendeesRestored: number;
  compensationsCancelled: number;
  /** 🔴 커밋 **후에** 구매확정 알림톡을 보내야 하는가. 이번 호출이 실제로 되돌린 경우만 true. */
  shouldNotify: boolean;
}

export async function repairPaidOrder(
  client: PoolClient,
  orderId: string,
  facts: RepairPaymentFacts,
): Promise<RepairOutcome> {
  // 🔴 이미 보상환불이 **실행된** 주문은 되돌리지 않는다. 돈이 이미 고객에게 돌아갔는데
  //    주문만 completed 로 만들면 "환불했는데 유효한 티켓" 이 된다. 사람이 봐야 한다.
  //
  // 🔴 **주문행을 먼저 잠근다 — 락 순서 통일.**
  //    `state-changed` 는 `lookupOrder` 가 주문을 FOR UPDATE 로 잠근 뒤 여기 들어온다
  //    (order → compensation). 대사는 곧장 여기로 들어온다. 여기서 보상행을 먼저
  //    잠그면 대사는 compensation → order 가 되어 **락 순서가 반대**가 되고,
  //    두 경로가 동시에 돌면 PostgreSQL 이 한쪽을 데드락으로 죽인다.
  //    순서를 order → compensation 으로 고정한다(state-changed 는 이미 잠겨 있어 무해).
  await client.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  //
  // 🔴 `FOR UPDATE` 가 핵심이다. 잠그지 않으면 TOCTOU 로 뚫린다:
  //    보상 드레인(`compensation.ts`)은 **다른 트랜잭션**에서 `FOR UPDATE SKIP LOCKED` 로
  //    pending→processing 을 클레임하고 **커밋한 뒤** 트랜잭션 밖에서 실 PG 환불을 집행한다.
  //    잠금 없이 count 만 읽으면: 여기서 0 을 읽음 → 드레인이 클레임·커밋 →
  //    아래 ④ 취소 UPDATE 는 processing 을 못 잡아 0행 → 우리는 그대로 completed 로
  //    되돌리고 알림톡까지 보내는데 **드레인은 환불을 집행**한다.
  //    우리가 먼저 잠그면 드레인의 SKIP LOCKED 가 이 주문을 비켜간다.
  const done = await client.query<{ status: string }>(
    `SELECT status FROM payment_compensation_actions
      WHERE order_id = $1
      FOR UPDATE`,
    [orderId],
  );
  const blocking = done.rows.filter((r) =>
    ["completed", "processing", "manual_review"].includes(r.status),
  );
  if (blocking.length > 0) {
    logger.error("🔴 repair 중단 — 이 주문에 보상환불이 이미 진행/완료됐다(수동 확인 필요)", {
      source: "repair-paid-order",
      orderId,
      v2OrderId: facts.v2OrderId,
      v2Status: facts.v2Status,
      blocking: blocking.map((r) => r.status),
    });
    return {
      repaired: false,
      attendeesRestored: 0,
      compensationsCancelled: 0,
      shouldNotify: false,
    };
  }

  const transition = await repairOrderToPaid(client, orderId, facts.v2Status);
  if (transition.status !== "applied") {
    // 이미 completed 거나(다른 tick 이 먼저 고침) 증거가 부족하다. **멱등** —
    // 대사가 5분마다 돌므로 여기서 매번 알림톡을 보내면 스팸이 된다.
    return {
      repaired: false,
      attendeesRestored: 0,
      compensationsCancelled: 0,
      shouldNotify: false,
    };
  }

  // 🔴 부분환불은 **앵커만** 맞춘다 — 참석자 복원도, "구매 완료" 발송도 하지 않는다.
  //    누가 환불분인지 모르는 채 되살리면 환불받은 사람에게 공지가 나가고, 잘못된
  //    안내는 회수할 수 없다.
  const isPartialRefund = String(facts.v2Status).trim().toLowerCase() === "partially_refunded";
  if (isPartialRefund) {
    logger.warn("부분환불 주문 — 앵커만 복구(참석자·알림 보류, 사람 판단 필요)", {
      source: "repair-paid-order",
      orderId,
      v2OrderId: facts.v2OrderId,
    });
  }

  // ② 결제 필드 투영. 값이 없으면 기존 값을 지우지 않는다(COALESCE).
  await client.query(
    `UPDATE orders
        SET payment_status = 'paid',
            paid_amount = GREATEST(COALESCE(paid_amount, 0), COALESCE($2, 0)),
            payment_method = COALESCE($3, payment_method),
            payment_reference = COALESCE($4, payment_reference),
            updated_at = NOW()
      WHERE id = $1`,
    [orderId, facts.amount ?? null, facts.method ?? null, facts.paymentReference ?? null],
  );

  // ③ 참석자 복원. 🔴 `checked_in` 은 제외한다 — 입장 이력을 되돌리면 재입장이 열린다.
  //    `pending` 도 confirmed 로 올린다(결제가 끝났으므로). 상태머신 전이표와 동일:
  //    pending→confirmed 허용, cancelled→confirmed 는 이 repair 만의 예외다.
  //    🔴 부분환불이면 **되살리지 않는다.** `attendees.v2_ticket_id` 가 있긴 하지만
  //       (내 이전 주석이 "매핑이 없다" 고 한 것은 틀렸다 — prod 36/36 채워져 있다),
  //       어느 티켓이 환불분인지는 v2 티켓 상태를 봐야 알 수 있고 그건 이 트랜잭션
  //       밖의 왕복이다. 잘못 되살리면 **환불받은 사람이 공지·리마인더 세그먼트에
  //       다시 들어간다**(`recipients.ts` 가 attendees 를 본다). 사람이 판단할 일이다.
  const att = isPartialRefund
    ? { rowCount: 0 }
    : await client.query(
        `UPDATE attendees SET status = 'confirmed', updated_at = NOW()
          WHERE order_id = $1 AND status IN ('cancelled', 'pending')`,
        [orderId],
      );

  // ④ 대기 중인 보상환불 취소. 이게 없으면 payment-reconcile 크론이 5분 뒤
  //    `refundOrder({full:true})` 로 **정당한 결제를 환불**한다.
  //    ⚠️ `processing`·`manual_review`·`completed` 는 위에서 이미 걸러졌다(여기 오지 않는다).
  //    원래 `reason` 은 지우지 않고 덧붙인다 — 왜 큐에 들어왔고 왜 취소됐는지 둘 다 남아야 한다.
  const comp = await client.query(
    `UPDATE payment_compensation_actions
        SET status = 'cancelled',
            reason = COALESCE(reason, '') || ' | repair: v2 결제유효 확인으로 취소',
            updated_at = NOW()
      WHERE order_id = $1
        AND status IN ('pending', 'failed', 'failed_retryable', 'unknown')`,
    [orderId],
  );

  logger.warn("🔴 결제 주문 앵커 복구(repair) — 전파 유실 보정", {
    source: "repair-paid-order",
    orderId,
    from: transition.from,
    v2OrderId: facts.v2OrderId,
    v2Status: facts.v2Status,
    attendeesRestored: att.rowCount ?? 0,
    compensationsCancelled: comp.rowCount ?? 0,
  });

  return {
    repaired: true,
    from: transition.from,
    attendeesRestored: att.rowCount ?? 0,
    compensationsCancelled: comp.rowCount ?? 0,
    shouldNotify: !isPartialRefund,
  };
}

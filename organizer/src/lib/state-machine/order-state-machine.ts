/**
 * ═══════════════════════════════════════════════════════════════════════════
 * W4-ORD — go `orders`/`attendees` 가 **왜 아직 살아 있는지** (잔여 앵커 등기부)
 * ═══════════════════════════════════════════════════════════════════════════
 * 커머스 SoT 는 v2 다. 그럼에도 go 에 남긴 두 테이블의 역할은 딱 아래 넷뿐이며,
 * 각각은 v2 로 옮길 수 **없는** 구조적 이유가 있다. 여기가 그 단일 등기부다 —
 * 새 read 를 추가하기 전에 이 목록에 해당하는지 먼저 확인할 것.
 *
 * ── ① go `orders` = 결제 상태머신 기질(substrate) ──────────────────────────
 *   이 파일의 `transitionOrder(pending→completed)` 가 조건부 UPDATE 의 **rowCount 를
 *   멱등 토큰**으로 쓴다. "동시 2회 결제확정" 에서 승자 1명을 뽑는 장치가 이것이다.
 *   v2 왕복으로는 go 트랜잭션과 원자화할 수 없어 대체 불가.
 *   · 소비자: order-finalize.ts · checkout/complete · payment/toss/confirm ·
 *            internal/orders/state-changed · cron/expire-orders · payment/reconcile
 *
 * ── ② go `orders` = pending-first 아웃박스의 앵커 행 ───────────────────────
 *   `recordPaymentConfirmOutbox(client, goOrderId)` 가 **같은 트랜잭션 안에서**
 *   `SELECT v2_order_id FROM orders WHERE id=$1` 을 한다. 앵커 행이 없으면
 *   "completed 커밋 ⟺ pending outbox 존재" 불변식이 깨져 결제는 됐는데 티켓이
 *   없는 상태가 난다. 아웃박스가 사라지기 전엔 앵커 행도 못 지운다.
 *
 * ── ③ go `orders` = go order id ↔ v2 order id 역인덱스 + go-native 컬럼 ────
 *   event id 와 달리 **order id 는 canonical 승격되지 않았다**(go id ≠ v2 id).
 *   `v2_order_id` 앵커가 유일한 매핑이다(v2 `by-external` 은 그 역방향 보조).
 *   `order_number`(shortId 채번)·`fraud_score`/`fraud_flags`(go 전용 이상탐지)·
 *   `memo` 도 v2 미보유 go-native 컬럼이다.
 *   또한 admin/webhook 계열의 `JOIN orders … AND o.account_id = $1` 은 계정 경계가
 *   없는 go-local 테이블(webhook DLQ 등)에 **테넌트 경계를 부여하는 유일한 수단**이다.
 *
 * ── ④ go `attendees` = 발송 세그먼트 원장 (W3-MSG 미이관) ──────────────────
 *   `lib/notification/recipients.ts` 가 `attendees.status`/연락처로 발송 대상을
 *   SQL 로 고르고, `cron/reminders` 가 같은 집합을 읽는다. v2 로 옮기려면 "세그먼트
 *   조건 → 수신자 연락처" 계약을 v2 에 새로 만들어야 하고(구매일 범위·추첨당첨·
 *   상품·체크인여부 교차), 그건 발송 트랙(W3-MSG)의 소관이다.
 *   ⟹ 그래서 `attendees` 는 **write 는 유지, read 는 발송 경로에만** 남긴다.
 *      취소 투영 UPDATE(주문취소/환불/만료/보상)도 이 세그먼트를 정확히 유지하기
 *      위한 것이다 — 지우면 취소된 사람에게 리마인더가 나간다.
 *
 * 🔴 위 넷에 해당하지 않는 go orders/attendees read 는 **결함**이다. 정본은 v2 다.
 */
import type { PoolClient } from "pg";
import type { OrderStatus } from "@/lib/types";

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["completed", "cancelled", "expired"],
  completed: ["refunded", "partially_refunded"],
  cancelled: [],
  refunded: [],
  partially_refunded: ["refunded"],
  expired: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus) {
  return ORDER_TRANSITIONS[from].includes(to);
}

export type OrderTransitionResult =
  | { status: "applied" }
  | { status: "not_found" }
  | { status: "condition_failed"; reason: "expired" | "concurrent_change" };

/**
 * 상태 전이의 결과를 보존하는 원시 연산.
 *
 * pending→completed 는 만료 시 UPDATE 자체가 0행이 되므로, 호출자가 이를
 * "이미 완료됨"이나 "일반 경합"으로 오인해 결제 메타데이터를 쓰거나 강제
 * UPDATE 하지 않도록 만료 사유를 구분한다.
 */
export async function transitionOrderDetailed(
  client: PoolClient,
  orderId: string,
  expectedFrom: OrderStatus,
  to: OrderStatus,
): Promise<OrderTransitionResult> {
  if (!canTransitionOrder(expectedFrom, to)) {
    throw new Error(`주문 상태를 ${expectedFrom}에서 ${to}로 변경할 수 없습니다`);
  }

  const expiryGuard =
    expectedFrom === "pending" && to === "completed"
      ? " AND (expires_at IS NULL OR expires_at > NOW())"
      : "";

  const result = await client.query(
    `
      UPDATE orders
      SET status = $3, updated_at = NOW()
      WHERE id = $1 AND status = $2${expiryGuard}
      RETURNING id
    `,
    [orderId, expectedFrom, to],
  );

  if ((result.rowCount ?? 0) > 0) {
    return { status: "applied" };
  }

  const current = await client.query<{ status: OrderStatus; expires_at: Date | null }>(
    `SELECT status, expires_at FROM orders WHERE id = $1`,
    [orderId],
  );
  if (current.rows.length === 0) {
    return { status: "not_found" };
  }

  const row = current.rows[0]!;
  if (
    expectedFrom === "pending" &&
    to === "completed" &&
    row.status === "pending" &&
    row.expires_at !== null &&
    row.expires_at.getTime() <= Date.now()
  ) {
    return { status: "condition_failed", reason: "expired" };
  }

  return { status: "condition_failed", reason: "concurrent_change" };
}

export async function transitionOrder(
  client: PoolClient,
  orderId: string,
  expectedFrom: OrderStatus,
  to: OrderStatus,
) {
  const result = await transitionOrderDetailed(client, orderId, expectedFrom, to);
  return result.status === "applied";
}

/**
 * 🔴 repair — **v2 가 결제를 유효로 확인해 준 주문만** `completed` 로 되돌린다.
 *
 * ## 왜 일반 전이로는 안 되나 (2026-07-31 실사고)
 * v2→go 결제확정 전파가 유실된 동안 결제된 주문이 go 에서 `pending` 으로 남았고,
 * 결제창 제한시간(15분)이 지나 두 벽에 동시에 막혔다:
 *   · `pending → completed` 는 위 `expiryGuard` 가 0행으로 만든다
 *   · `expired` 는 `ORDER_TRANSITIONS` 에 **탈출 경로가 없다**(`expired: []`)
 * ⟹ 만료 가드만 넣으면 크론도 못 죽이고 대사도 못 고치는 **영구 pending livelock** 이 된다.
 *
 * ## 왜 우회가 아니라 전이인가
 * 직접 UPDATE 로 상태를 덮는 코드가 늘어나면 상태머신은 장식이 된다. 그래서
 * **되돌리기 조건을 계약으로 명시**한다 — 호출자는 v2 증거(`v2Status`)를 반드시
 * 제시해야 하고, 그 값이 결제 유효 상태가 아니면 이 함수는 **아무것도 하지 않는다**.
 * "왜 상태가 바뀌었나" 를 나중에 물었을 때 답할 수 있어야 한다.
 *
 * ## 함께 해제하는 것
 * `expires_at` 을 NULL 로 만든다. 결제가 끝난 주문에 결제창 제한시간이 남아 있으면
 * 만료 크론·`state-changed` 의 만료판정이 **다시 같은 사고를 낸다**. 뿌리를 끊는다.
 *
 * @param v2Status v2 가 보고한 상태. `confirmed|paid|partially_refunded` 만 허용.
 */
export async function repairOrderToPaid(
  client: PoolClient,
  orderId: string,
  v2Status: string,
): Promise<{ status: "applied" | "noop"; from?: OrderStatus }> {
  const evidence = String(v2Status ?? "").trim().toLowerCase();
  if (!REPAIRABLE_V2_STATUSES.has(evidence)) {
    // 증거가 없으면 손대지 않는다. 호출자가 실수로 빈 값을 넘겨도 파괴적이지 않다.
    return { status: "noop" };
  }

  // 직전 상태를 CTE 로 먼저 잠가서 읽는다 — UPDATE 의 RETURNING 은 **갱신 후** 값이라
  // "무엇에서 되돌렸는지" 를 못 남긴다. 감사에는 그 값이 필요하다.
  const result = await client.query<{ from_status: OrderStatus }>(
    `
      WITH prev AS (
        SELECT status FROM orders WHERE id = $1 FOR UPDATE
      ), upd AS (
        UPDATE orders
           SET status = 'completed', expires_at = NULL, updated_at = NOW()
         WHERE id = $1
           AND status IN ('pending', 'expired')
        RETURNING id
      )
      SELECT prev.status AS from_status FROM prev, upd
    `,
    [orderId],
  );
  const from = result.rows[0]?.from_status;
  if (!from) {
    return { status: "noop" };
  }
  return { status: "applied", from };
}

/** repair 를 허용하는 v2 상태 — 이 목록 밖이면 되돌리지 않는다. */
const REPAIRABLE_V2_STATUSES = new Set(["confirmed", "paid", "partially_refunded"]);

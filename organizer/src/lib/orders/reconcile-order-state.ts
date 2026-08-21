/**
 * 역방향 대사 — v2 가 결제 유효로 보는데 go 앵커가 뒤처진 주문을 되돌린다.
 *
 * ## 🔴 왜 (2026-07-31)
 * v2→go 결제확정 전파(`propagate_order_event` → celery)가 **한 번도 도달한 적이 없었다**.
 * 기존 `payment-reconcile` 은 **반대 방향**(go=completed·v2 미확정)만 본다 —
 * 이 방향을 고치는 것이 **아무것도 없었다**.
 *
 * ## 설계 원칙
 * > 푸시는 빠르기 위한 것이고, **정합은 대사가 보장한다.**
 *
 * 전파가 왜 죽었는지 몰라도 이 대사가 있으면 수렴한다. 반대로 전파만 고치면
 * 다음에 또 조용히 새는 날 아무도 모른다(실제로 며칠 몰랐다).
 *
 * ## 스캔 대상 — `pending` 만 보면 안 된다
 * 만료 크론이 이미 훑고 간 주문은 `expired` 다. 실제 사고 건(`ORD-260731-002`)도
 * 발견 시점에 이미 `expired` 였다. 그래서 **둘 다** 스캔한다.
 *
 * ## 멱등 — 발송 원장이 없다
 * go 메시징 원장은 mig250 으로 DROP 됐고 v2 `message_deliveries` 는 트랜잭션 알림을
 * 거치지 않는다. ⟹ "completed 인데 알림 안 나간 주문" 을 스캔하는 설계는 **금지**다
 * (판별 근거가 없어 5분마다 무한 재발송이 된다).
 * 그래서 **이번 tick 이 실제로 되돌린 주문에만** 발송한다. repair 전이는 한 번만
 * 성공하므로 그것이 곧 발송 잠금이다.
 */
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import {
  PURCHASE_CONFIRM_ORDER_SELECT,
  sendPurchaseConfirm,
  type PurchaseConfirmOrderRow,
} from "@/lib/notification/purchase-confirm-sender";
import { repairPaidOrder } from "@/lib/orders/repair-paid-order";
import { askV2AboutOrder, type V2Verdict } from "@/lib/orders/v2-authority";

/**
 * 한 tick 에서 검사할 주문 수 상한. 후보 1건당 v2 왕복 1회다.
 * 넘치면 잘라내되 **요약에 표시**한다 — 남은 건 다음 tick 이 오래된 것부터 이어받는다.
 */
const SCAN_LIMIT = 200;

export interface ReconcileSummary {
  scanned: number;
  repaired: number;
  notified: number;
  notifyFailed: number;
  /** v2 도 끝났다고 본 건 — 정상이다(사고가 아니다). */
  terminal: number;
  /** 아직 결제 전 — 정상. 경보 대상이 아니다. */
  inFlight: number;
  /** v2 에 못 물어본 건 — 다음 tick 재시도. */
  undecidable: number;
  capped: boolean;
}

export async function reconcileOrderState(): Promise<ReconcileSummary> {
  const pool = getPool();
  const summary: ReconcileSummary = {
    scanned: 0, repaired: 0, notified: 0, notifyFailed: 0,
    terminal: 0, inFlight: 0, undecidable: 0, capped: false,
  };

  // 후보: go 가 아직 결제완료로 보지 않는 주문.
  // ⚠️ `pending` 뿐 아니라 `expired` 도 본다 — 만료 크론이 이미 훑고 갔을 수 있다.
  //    무통장 대기(`v2_order_id IS NULL`)는 제외한다. 그건 전파 대상이 아니라
  //    주최자 입금확정을 기다리는 정상 상태다.
  // 🔴 **후보를 좁히는 것이 기아의 진짜 해법이다.**
  //    종전엔 `status IN ('pending','expired')` 전부를 봤다. 그러면 **결제 진행 중인
  //    정상 주문**이 후보 선두를 채우고(오래된 것부터 보므로), 아무리 스캔해도 변하지
  //    않는 그것들이 상한 200 을 다 먹어 **뒤쪽의 실제 사고 건은 영원히 안 잡힌다.**
  //    그 기아는 곧장 보상 드레인에 공급된다 — 대사가 못 본 정당결제를 드레인이 먼저 환불한다.
  //
  //    대사가 필요한 건 "go 앵커가 뒤처진" 주문뿐이고, 그건 **결제창이 이미 지난** 것들이다:
  //      · `expired`                          — go 가 이미 포기함
  //      · `pending` 인데 `expires_at` 경과    — 결제창이 끝났는데 아직 pending
  //    아직 창 안에 있는 주문은 **정상**이므로 v2 에 물어볼 필요조차 없다.
  //    (이 좁히기가 in-flight 경보 소음도 근본에서 없앤다.)
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE v2_order_id IS NOT NULL
        AND (
          status = 'expired'
          OR (status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW())
        )
      ORDER BY updated_at ASC
      LIMIT $1`,
    [SCAN_LIMIT + 1],
  );
  const rows = candidates.rows.slice(0, SCAN_LIMIT);
  summary.capped = candidates.rows.length > SCAN_LIMIT;
  summary.scanned = rows.length;

  for (const row of rows) {
    const verdict = await askV2AboutOrder(row.id);
    if (verdict.kind === "terminal" || verdict.kind === "absent") {
      summary.terminal += 1;
      continue;
    }
    if (verdict.kind === "in_flight") {
      // 🔴 결제 진행 중인 정상 주문이다. 여기를 undecidable 로 세면
      //    **결제자가 한 명만 있어도 5분마다 degraded 경보**가 울리고,
      //    진짜 유실 신호가 그 소음에 묻힌다.
      summary.inFlight += 1;
      continue;
    }
    if (verdict.kind === "unknown") {
      summary.undecidable += 1;
      continue;
    }

    // v2 가 결제 유효로 본다 — go 가 뒤처진 것이다.
    const notifyRow = await repairOne(pool, row.id, verdict);
    if (!notifyRow) continue;
    summary.repaired += 1;

    // 🔴 발송은 **커밋 후**. 트랜잭션 안에서 보내면 롤백돼도 카톡은 이미 나가 있다.
    const sent = await sendPurchaseConfirm(notifyRow);
    if (sent.sent) {
      summary.notified += 1;
    } else {
      summary.notifyFailed += 1;
      // 발송 실패는 원장에 남지 않는다(발송 원장 자체가 없다). 로그가 유일한 흔적이다.
      logger.warn("대사 복구 후 구매확정 알림 미발송", {
        source: "reconcile-order-state",
        goOrderId: row.id,
        orderNumber: notifyRow.orderNumber,
        reason: sent.reason,
      });
    }
  }

  if (summary.repaired > 0 || summary.undecidable > 0) {
    logger.warn("🔴 v2→go 전파 유실 보정", { source: "reconcile-order-state", ...summary });
  }
  return summary;
}

/**
 * 한 건을 트랜잭션으로 되돌리고, 발송에 필요한 행을 돌려준다.
 * 되돌리지 못했으면(이미 고쳐졌거나 보상환불이 진행 중) `null` — 발송하지 않는다.
 */
async function repairOne(
  pool: ReturnType<typeof getPool>,
  goOrderId: string,
  verdict: Extract<V2Verdict, { kind: "paid" }>,
): Promise<PurchaseConfirmOrderRow | null> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    // 🔴 금액·수단을 **반드시 함께** 넘긴다. 안 넘기면 COALESCE(…,0) 으로 0 이 박히고
    //    payment_method 는 주문 생성 시의 'offline' 로 남는다(실측 사고).
    const outcome = await repairPaidOrder(client, goOrderId, {
      v2Status: verdict.v2Status,
      v2OrderId: verdict.v2OrderId,
      amount: verdict.facts.amount,
      method: verdict.facts.method,
    });
    if (!outcome.repaired) {
      await client.query("ROLLBACK");
      return null;
    }
    // 발송에 쓸 값은 **같은 트랜잭션에서** 읽는다 — 참석자 복원이 반영된 ticketCount 를 써야 한다.
    const row = await client.query<PurchaseConfirmOrderRow>(
      PURCHASE_CONFIRM_ORDER_SELECT,
      [goOrderId],
    );
    await client.query("COMMIT");
    return row.rows[0] ?? null;
  } catch (e: unknown) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("대사 복구 실패(다음 tick 재시도)", {
      source: "reconcile-order-state",
      goOrderId,
      error: e instanceof Error ? e.message : "unknown",
    });
    return null;
  } finally {
    client.release();
  }
}

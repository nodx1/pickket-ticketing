import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { projectToGoOrderStatus } from "@/lib/domain-model";
import { ERR } from "@/lib/errors";
import { getOrderDetail } from "@/lib/server/orders";
import { canTransitionOrder } from "@/lib/state-machine/order-state-machine";
import type { OrderStatus } from "@/lib/types";
import {
  cancelOrder as v2CancelOrder,
  getOrder,
  refundOrder as v2RefundOrder,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";

type Params = { eventId: string; orderId: string };

const updateSchema = z.object({
  memo: z.string().optional(),
  status: z.enum(["pending", "completed", "cancelled", "refunded", "partially_refunded", "expired"]).optional(),
  /** 부분 환불 금액(원). 생략 시 잔여 전액 환불. partially_refunded 전이에 사용. */
  refundAmount: z.number().int().positive().optional(),
  /** 잔액을 남긴 채 주문을 **영구 종결**한다는 명시 의사표시(적대검수 H1). 기본 false. */
  closeRemainder: z.boolean().optional(),
  /** 환불/취소 사유(v2 audit). */
  reason: z.string().optional(),
  /**
   * 입장 완료 티켓이 있어도 환불을 강행한다는 **명시 의사표시**(감사 F4·F6). 기본 false.
   * 켤 때는 `reason` 이 필수다 — 근거 없이 입장객을 환불할 수 없다.
   */
  allowAdmitted: z.boolean().optional(),
});

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  const detail = await getOrderDetail(session.accountId, params.eventId, params.orderId);
  if (!detail) {
    return errorResponse(ERR.NOT_FOUND, 404);
  }
  return successResponse(detail);
});

/**
 * 주문 상태 변경 — 빅뱅 flip: 환불/취소는 v2 원자 API write-through.
 *
 *  - refunded / partially_refunded → commerce-client.refundOrder (티켓 CANCELLED + 좌석 SOLD→AVAILABLE 원자).
 *  - cancelled                     → commerce-client.cancelOrder  (미결제 주문, 좌석/티켓 release 원자).
 *  - memo 단독 변경                → go-local UPDATE (워크플로 메모, 커머스 상태 무관).
 *
 * go orders 행은 thin 앵커 — v2 성공 후 상태/환불액을 **투영 캐시**로만 동기화한다.
 * go 에서 직접 좌석/티켓 취소 금지(원자성=v2 소유). V2CommerceError 는 상태코드 그대로 전파.
 */
export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  // 🔴 `request.json()` 은 try **밖**에서 부르지 않는다. 본문이 비었거나 JSON 이 아니면
  //    SyntaxError 가 나는데, ZodError 가 아니라서 아래 catch 가 **500(ERR.SERVER)** 로
  //    떨어뜨린다 — 요청이 잘못된 것뿐인데 서버 장애로 보인다.
  //    체크인 라우트에서 같은 유형을 고쳐놓고(348f1e3) 이 파일은 놓쳤다.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("요청 본문이 올바른 JSON 이 아닙니다", 400);
  }
  try {
    const body = updateSchema.parse(raw);
    const pool = getPool();
    const currentOrderResult = await pool.query<{ status: OrderStatus; v2_order_id: string | null }>(
      `
        SELECT status, v2_order_id
        FROM orders
        WHERE account_id = $1 AND event_id = $2 AND id = $3
        LIMIT 1
      `,
      [session.accountId, params.eventId, params.orderId],
    );

    if (currentOrderResult.rows.length === 0) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    const currentStatus = currentOrderResult.rows[0]!.status;
    const v2OrderId = currentOrderResult.rows[0]!.v2_order_id;

    // ── 상태 전이 요청(환불/취소)이면 v2 write-through. ──────────────────────────
    if (body.status && body.status !== currentStatus) {
      if (!canTransitionOrder(currentStatus, body.status)) {
        return errorResponse("허용되지 않은 주문 상태 변경입니다", 400);
      }
      if (!v2OrderId) {
        return errorResponse("주문이 v2 와 연결되지 않아 상태를 변경할 수 없습니다 (v2_order_id 누락)", 409);
      }

      try {
        if (body.status === "refunded" || body.status === "partially_refunded") {
          // ── 🔴 감사 F6: 이 경로가 정본 환불 라우트의 게이트를 통째로 우회하고 있었다 ──
          //
          // `POST .../refund` 는 ① 입장 완료 티켓 차단 ② 환불정책(calculateRefund) 금액 산정
          // 을 거치는데, 여기는 **둘 다 없이** 임의 금액을 v2 로 바로 보냈다.
          // ⟹ 입장한 관객을 환불하는 것도, 정책을 무시한 금액을 밀어넣는 것도 가능했다.
          //
          // 금액 자유도는 이 경로의 **의도된 성격**이다(운영자 수동 조정). 그래서 정책 계산은
          // 강제하지 않되, **입장 게이트는 동일하게 적용**한다 — 돈이 새는 쪽만 막는다.
          //
          // 멱등키도 정본과 **같은 체계**로 맞춘다. 종전엔 `:{status}:{amount}` 라
          // 같은 환불을 두 경로로 넣으면 v2 가 서로 다른 키로 보아 **중복 환불**될 수 있었다.
          let v2Order: Awaited<ReturnType<typeof getOrder>>;
          try {
            v2Order = await getOrder(v2OrderId);
          } catch (err: unknown) {
            if (err instanceof V2CommerceError) {
              const status = err.status >= 400 && err.status < 500 ? err.status : 502;
              return errorResponse(err.message, status);
            }
            throw err;
          }

          const admitted = v2Order.tickets.filter(
            (t: { checked_in_at: string | null; status: string }) =>
              t.checked_in_at !== null || t.status === "used",
          );
          const allowAdmitted = body.allowAdmitted === true;
          if (admitted.length > 0 && !allowAdmitted) {
            return errorResponse(
              `이미 입장한 티켓이 ${admitted.length}장 있어 환불할 수 없습니다. ` +
                `대회 중단 등으로 입장객까지 환불해야 한다면 사유와 함께 예외 승인으로 진행해주세요.`,
              409,
            );
          }
          if (allowAdmitted && !body.reason) {
            return errorResponse("입장객 환불 예외 승인은 사유가 필요합니다", 400);
          }

          // 🔴 T20b — `partially_refunded` 인데 금액이 없으면 **거부**한다.
          //
          // go 는 `status` 로 부분/전액을 구분하지만 v2 는 status 를 받지 않는다.
          // v2 계약(`internal_commerce.py:4658`)은 이렇다:
          //     if body.full or body.amount is None:  → **전액환불**
          // 즉 "금액을 안 보냈다"가 "전액 환불하라"로 해석된다. 그래서 `partially_refunded`
          // + 금액 누락이면 go 는 부분으로 분류해 보내는데 v2 는 **전액을 환불한다**.
          // 게다가 `{amount: undefined}` 는 JSON 직렬화에서 키째 사라져 "둘 다 없음"이 된다.
          //
          // ⟹ **누락이 곧 최대 파괴적 동작**으로 해석되는 구조다. 여기서 끊는다.
          //    (v2 쪽에도 같은 400 가드를 넣는 중 — 다른 호출자가 같은 실수를 하면 그대로
          //     전액환불이 나가므로 두 층이 독립적으로 막아야 한다.)
          if (body.status === "partially_refunded" && body.refundAmount == null) {
            return errorResponse(
              "부분 환불은 금액을 지정해야 합니다. 전액 환불하려면 상태를 'refunded' 로 보내주세요.",
              400,
            );
          }

          // 부분(refundAmount) 또는 전액(full).
          // 🔴 `cancel_all` — 돈과 계약을 분리한다 (2026-07-31, 코덱스 감사 P0-1 의 **잔여분**).
          //    감사는 정본 환불 라우트(`POST .../refund`)만 지적했고 거기만 고쳐졌는데,
          //    이 경로에도 **같은 구멍**이 있었다. v2 는 `is_full` 또는 `cancel_all` 일 때만
          //    티켓·좌석을 푼다:
          //
          //      status="refunded" + refundAmount 지정 → isFull=false → amount 로 전송
          //        ⟹ 주문은 "환불 종결" 인데 **티켓은 ACTIVE · 좌석은 SOLD** 로 남는다.
          //           운영자가 수수료를 떼고 환불 종결 처리하면 그 손님이 그대로 입장한다.
          //
          //    `status="refunded"` 는 **구매계약을 끝낸다는 의사표시**다. 금액이 얼마든 티켓은
          //    죽어야 한다. `partially_refunded` 는 진짜 부분환불이므로 그대로 둔다.
          const isFull = body.status === "refunded" && body.refundAmount == null;
          const cancelAll = body.status === "refunded";

          // 🔴 잔액을 남긴 채 **영구 종결**되는 조합을 막는다 (2026-07-31 적대검수 H1).
          //
          // `cancel_all` 을 켜면 v2 가 주문을 REFUNDED 로 확정하는데, REFUNDED 는 **종결 상태**다
          // (`_REFUNDABLE = {CONFIRMED, PAID, PARTIALLY_REFUNDED}` — REFUNDED 는 없다).
          //
          //   50,000원 주문에 {status:"refunded", refundAmount:1000}
          //     → 1,000원만 나가고 티켓 전부 취소 + 주문 REFUNDED 확정
          //     → 잔액 49,000원은 **어떤 API 로도 못 나간다.** 손님은 돈도 티켓도 없다.
          //
          // 수수료 차감 종결은 정당한 조작이지만(정본 환불 라우트가 그렇게 한다), 이 경로는
          // **임의 금액**을 받으므로 오타 한 번이 복구 불가가 된다. `refundAmount` 를 쓰는
          // UI 호출자는 0곳이고, 이 화면을 쓸 수 있는 역할에는 **발주처 팀원(manager)** 도
          // 포함된다(`withRole("organizer")` 가 manager 를 통과시킨다).
          // ⟹ 명시 의사표시를 요구한다. `allowAdmitted` 와 같은 방식이다.
          if (cancelAll && body.refundAmount != null) {
            const remainder = Math.max(v2Order.paid_amount - v2Order.total_refunded - body.refundAmount, 0);
            if (remainder > 0 && body.closeRemainder !== true) {
              return errorResponse(
                `잔액 ${remainder.toLocaleString("ko-KR")}원을 남긴 채 주문을 종결하려 합니다. ` +
                  `종결하면 남은 금액은 환불할 수 없습니다. 의도한 것이면 closeRemainder=true 로 다시 요청하고, ` +
                  `나중에 더 환불할 계획이면 status='partially_refunded' 로 보내주세요.`,
                400,
              );
            }
          }
          const targetTotal = isFull
            ? v2Order.paid_amount
            : v2Order.total_refunded + Number(body.refundAmount ?? 0);
          const r = await v2RefundOrder(
            v2OrderId,
            isFull
              ? { full: true, reason: body.reason, allow_admitted: allowAdmitted }
              : {
                  amount: body.refundAmount,
                  cancel_all: cancelAll,
                  reason: body.reason,
                  allow_admitted: allowAdmitted,
                },
            // 정본 환불 라우트와 동일 체계: 주문 + **목표 누적환불액**.
            { idempotencyKey: `go-refund:${params.orderId}:${targetTotal}` },
          );
          if (allowAdmitted) {
            logger.warn("[order-patch] 입장객 환불 예외 승인", {
              eventId: params.eventId,
              orderId: params.orderId,
              admittedTickets: admitted.length,
              reason: body.reason,
              approvedBy: session.id,
            });
          }
          // go 앵커 동기화(표시 캐시) — v2 status 투영 + 누적 환불액.
          await pool.query(
            `
              UPDATE orders
              SET status = $4, refund_amount = $5, memo = COALESCE($6, memo), updated_at = NOW()
              WHERE account_id = $1 AND event_id = $2 AND id = $3
            `,
            [
              session.accountId,
              params.eventId,
              params.orderId,
              projectToGoOrderStatus(r.status),
              r.total_refunded,
              body.memo ?? null,
            ],
          );
          // 전액환불 시 go attendees 앵커도 cancelled 캐스케이드(v2 tickets=cancelled와 정합).
          //   미동기화 시 go-local 직접집계 경로에서 환불건이 confirmed로 누수(실증 발견 P2).
          if (isFull) {
            await pool.query(
              `UPDATE attendees SET status = 'cancelled', updated_at = NOW()
               WHERE order_id = $1 AND status != 'cancelled'`,
              [params.orderId],
            );
          }
        } else if (body.status === "cancelled") {
          // 미결제 주문 취소(PENDING/PAYMENT_REQUIRED). 결제완료는 v2 가 422 → 환불 안내.
          const c = await v2CancelOrder(
            v2OrderId,
            { reason: body.reason },
            { idempotencyKey: `go-cancel:${params.orderId}` },
          );
          await pool.query(
            `
              UPDATE orders
              SET status = $4, memo = COALESCE($5, memo), updated_at = NOW()
              WHERE account_id = $1 AND event_id = $2 AND id = $3
            `,
            [
              session.accountId,
              params.eventId,
              params.orderId,
              projectToGoOrderStatus(c.status),
              body.memo ?? null,
            ],
          );
        } else {
          // completed/expired/pending 등 직접 전이는 v2 SoT 가 결제/만료로 파생 — go 임의 전이 금지.
          return errorResponse("해당 상태 변경은 결제/시스템 이벤트로만 가능합니다", 400);
        }
      } catch (err: unknown) {
        if (err instanceof V2CommerceError) {
          // 4xx 는 사용자 에러(전이불가/결제완료 등), 5xx 는 일시 오류.
          const status = err.status >= 400 && err.status < 500 ? err.status : 502;
          return errorResponse(err.message, status === 422 ? 422 : status === 409 ? 409 : status >= 500 ? 502 : 400);
        }
        return errorResponse(ERR.SERVER, 500);
      }

      const detail = await getOrderDetail(session.accountId, params.eventId, params.orderId);
      return successResponse(detail);
    }

    // ── memo 단독 변경(상태 동일/미지정) — go-local 워크플로. ─────────────────────
    if (body.memo !== undefined) {
      const { rows } = await pool.query(
        `
          UPDATE orders
          SET memo = $4, updated_at = NOW()
          WHERE account_id = $1 AND event_id = $2 AND id = $3 AND status = $5
          RETURNING id
        `,
        [session.accountId, params.eventId, params.orderId, body.memo, currentStatus],
      );
      if (rows.length === 0) {
        return errorResponse("주문 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해주세요", 409);
      }
    }

    const detail = await getOrderDetail(session.accountId, params.eventId, params.orderId);
    return successResponse(detail);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

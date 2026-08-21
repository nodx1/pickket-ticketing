import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { finalizeOrderPayment } from "@/lib/server/order-finalize";
import { getOrderDetail } from "@/lib/server/orders";
import { checkDepositEligibility } from "@/lib/orders/deposit-eligibility";
import { getOrder, V2CommerceError } from "@/lib/v2/commerce-client";

type Params = { eventId: string; orderId: string };

/**
 * 무통장입금 입금확정 — 주최자 전용 (감사 P0-F).
 *
 * 구매자는 무통장입금을 self-complete 할 수 없고 입금대기(pending)로만 남는다.
 * 주최자가 계좌에서 실입금을 확인한 뒤 이 API 로 주문을 확정한다:
 *   pending → completed + paid + 참석자 confirmed + 티켓/좌석 확정 + v2 결제확정 write-through.
 *
 * 권한: withRole("organizer") + 주문이 세션 계정/이벤트 소속인지 재확인(수평 권한상승 차단).
 * 대상 제한: `checkDepositEligibility()` — status=pending + 무통장 결제수단 +
 *   **PG 결제가 걸려 있지 않을 것**. 마지막 조건이 없으면 카드 결제 이탈 주문을 확정해
 *   돈을 안 받고 티켓이 발권된다(go 는 소비자 주문도 payment_method='offline' 로 적는다).
 */
export const POST = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      status: string;
      payment_method: string | null;
      v2_order_id: string | null;
    }>(
      `
        SELECT status, payment_method, v2_order_id
        FROM orders
        WHERE account_id = $1 AND event_id = $2 AND id = $3
        LIMIT 1
      `,
      [session.accountId, params.eventId, params.orderId],
    );
    if (rows.length === 0) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }
    const order = rows[0]!;

    if (order.status === "completed") {
      // 멱등: 이미 확정된 주문은 성공으로 취급.
      const detail = await getOrderDetail(session.accountId, params.eventId, params.orderId);
      return successResponse(detail);
    }
    // PG 결제 여부는 v2 가 정본(go 는 소비자 주문도 offline 로 적어 구분 불가).
    // 🔴 조회 실패는 `undefined` 로 두고 fail-closed — 모를 때 확정을 열어주면 돈을 못 받는다.
    let hasPgPayment: boolean | undefined;
    if (order.v2_order_id) {
      try {
        hasPgPayment = (await getOrder(order.v2_order_id)).has_pg_payment;
      } catch (err: unknown) {
        if (!(err instanceof V2CommerceError)) throw err;
        hasPgPayment = undefined;
      }
    }

    const eligibility = checkDepositEligibility({
      status: order.status,
      paymentMethod: order.payment_method,
      hasPgPayment,
    });
    if (!eligibility.ok) {
      return errorResponse(eligibility.reason, eligibility.status);
    }

    const outcome = await finalizeOrderPayment(params.orderId, eligibility.paymentMethod);
    switch (outcome.kind) {
      case "not_found":
        return errorResponse(ERR.NOT_FOUND, 404);
      case "conflict":
        return errorResponse("주문 상태가 변경되었습니다. 새로고침 후 다시 시도해주세요", 409);
      case "seat_expired":
        return errorResponse(
          "좌석 잠금이 만료되어 입금확정을 완료할 수 없습니다. 환불 처리됩니다.",
          409,
        );
      case "already_completed":
      case "completed": {
        const detail = await getOrderDetail(session.accountId, params.eventId, params.orderId);
        return successResponse(detail);
      }
    }
  } catch (err: unknown) {
    console.error("[orders/confirm-deposit] 500", err);
    return errorResponse(ERR.SERVER, 500);
  }
});

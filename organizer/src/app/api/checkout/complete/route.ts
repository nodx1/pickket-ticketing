import { cookies } from "next/headers";
import { isProdRuntime } from "@/lib/env/runtime";
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { arePaymentsLive, ONLINE_PAYMENT_METHODS } from "@/lib/payment/mode";
import { finalizeOrderPayment } from "@/lib/server/order-finalize";
import { OFFLINE_PAYMENT_DEADLINE_HOURS } from "@/lib/checkout/offline-payment";

const completeSchema = z.object({
  orderId: z.string().uuid(),
  paymentMethod: z.enum(["offline", "bank_transfer", "card", "toss", "kakaopay", "naverpay"]),
});

/** 구매자 self-complete 로 확정하면 안 되는 결제수단(실입금은 주최자 입금확정 경유). */
const OFFLINE_PAYMENT_METHODS = ["offline", "bank_transfer"] as const;

async function completeHandler(request: Request) {
  try {
    const body = completeSchema.parse(await request.json());

    // P0: 소유권 검증. checkout/initiate 가 발급한 httpOnly 쿠키(pickket_last_order)와
    // 완료 대상 orderId 가 일치해야 한다. 이 검증이 없으면 무인증 상태에서 임의의 orderId 를
    // 완료·'paid' 처리해 티켓 발급 + v2 매출 위조가 가능하다. (감사 P0-5)
    const cookieStore = await cookies();
    const ownedOrderId = cookieStore.get("pickket_last_order")?.value;
    if (!ownedOrderId || ownedOrderId !== body.orderId) {
      return errorResponse("주문 소유권을 확인할 수 없습니다", 403);
    }

    // 보안: 온라인 결제수단(card/toss/kakaopay/naverpay)은 self-complete 를 금지한다 —
    // 반드시 각 PG approve/webhook(금액·승인 검증)을 거쳐야 한다. 실 PG 라이브일 때는 물론,
    // 프로덕션 런타임에서는 mock 오설정(TOSS_SECRET_KEY 누락)으로 arePaymentsLive 가
    // false 가 되어도 우회되지 않도록 항상 차단한다. (dev/test/mock 은 데모·E2E 호환 위해 허용)
    // (감사 P0-5)
    const prodStrict = isProdRuntime();
    if (
      (ONLINE_PAYMENT_METHODS as readonly string[]).includes(body.paymentMethod) &&
      (arePaymentsLive() || prodStrict)
    ) {
      return errorResponse(
        "온라인 결제는 결제 게이트웨이를 통해 완료해야 합니다",
        400,
      );
    }

    // 무통장입금/오프라인: 구매자 self-complete 로 즉시 확정 금지 (감사 P0-F).
    // 실입금 0원으로 유효티켓 + v2 매출이 위조되지 않도록, 주문을 입금대기(pending)로 유지하고
    // 결제수단만 기록한 뒤 안내를 돌려준다. 실입금 확인·확정은 주최자가 입금확정 API
    // (POST /api/events/[eventId]/orders/[orderId]/confirm-deposit) 로 수행한다.
    if ((OFFLINE_PAYMENT_METHODS as readonly string[]).includes(body.paymentMethod)) {
      const pool = getPool();
      // 🔴 무통장으로 **바꾼 시점에 만료를 다시 잡는다** (2026-08-21 실사고).
      //    카드로 시작하면 15분이 박히고, 손님이 무통장을 고르면 결제수단만 바뀌어
      //    **만료는 15분 그대로**였다 — 은행 갈 시간도 없이 만료된다.
      //    실측: 박희진 19분·김지민 15분 · 무통장 만료 9건 225,000원.
      //    ⚠️ 늘리기만 한다(GREATEST) — 이미 24시간짜리면 줄이지 않는다.
      const { rows } = await pool.query<{
        id: string;
        status: string;
        orderNumber: string;
        totalAmount: number;
      }>(
        `
          UPDATE orders
          SET payment_method = $2,
              expires_at = GREATEST(
                COALESCE(expires_at, NOW()),
                NOW() + ($3 || ' hours')::interval
              ),
              updated_at = NOW()
          WHERE id = $1 AND status = 'pending'
          RETURNING id, status, order_number AS "orderNumber", total_amount AS "totalAmount"
        `,
        [body.orderId, body.paymentMethod, String(OFFLINE_PAYMENT_DEADLINE_HOURS)],
      );
      if (rows.length === 0) {
        // pending 이 아님 — 이미 확정/취소/만료. 무통장 재확정 방지.
        const existing = await pool.query<{ status: string }>(
          `SELECT status FROM orders WHERE id = $1 LIMIT 1`,
          [body.orderId],
        );
        if (existing.rows.length === 0) {
          return errorResponse(ERR.NOT_FOUND, 404);
        }
        if (existing.rows[0]!.status === "completed") {
          return successResponse({ id: body.orderId, status: "completed", awaitingDeposit: false });
        }
        return errorResponse("이미 처리된 주문입니다", 409);
      }
      return successResponse({
        id: rows[0]!.id,
        status: "pending",
        awaitingDeposit: true,
        orderNumber: rows[0]!.orderNumber,
        totalAmount: rows[0]!.totalAmount,
      });
    }

    // 온라인 PG 승인 완료 or 데모/E2E mock 경로 → 결제확정(공용 헬퍼).
    const outcome = await finalizeOrderPayment(body.orderId, body.paymentMethod);
    switch (outcome.kind) {
      case "not_found":
        return errorResponse(ERR.NOT_FOUND, 404);
      case "conflict":
        return errorResponse("이미 처리된 주문입니다", 409);
      case "seat_expired":
        return errorResponse(
          "좌석 잠금이 만료되었습니다. 결제 금액은 자동으로 환불 처리됩니다.",
          409,
        );
      case "already_completed":
        return successResponse(outcome.order);
      case "completed":
        return successResponse(outcome.order);
    }
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    // 디버깅 추적 — production 에서도 결제 완료 실패 원인은 반드시 로그 (PII 없음)
    console.error("[checkout/complete] 500", err);
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 10,
  windowMs: 60_000,
  keyPrefix: "checkout:complete",
})(completeHandler);

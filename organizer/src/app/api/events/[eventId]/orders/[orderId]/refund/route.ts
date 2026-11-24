import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { projectToGoOrderStatus } from "@/lib/domain-model";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { notifyRefundRequest } from "@/lib/notifications/create";
import { findV2OnlyOrder } from "@/lib/server/orders";
import { calculateCancellationRefund, toLegacyPreview, toTiers } from "@/lib/refund/cancellation-fee";
import { getEventForRefund, refundPolicyErrorStatus } from "@/lib/refund/policy";
import type { OrderStatus } from "@/lib/types";
import { dispatchWebhook } from "@/lib/webhook/dispatcher";
import { getOrder, refundOrder as v2RefundOrder, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, getOwnedEvent } from "@/lib/v2/event-access";
import { auditClientIp } from "@/lib/request-ip";

/** v2 환불 응답에서 이 라우트가 쓰는 부분. 응답 유실 시 재조회로도 같은 모양을 만든다. */
type RefundOutcome = {
  status: string;
  total_refunded: number;
  refunded: number;
  seats_released: number;
};

type Params = { eventId: string; orderId: string };

/**
 * 주최자 환불 — 빅뱅 flip: 환불 원자성은 v2 SoT.
 *
 * go 는 환불 정책(calculateRefund)으로 **금액만** 산정하고, 실제 환불(좌석 SOLD→AVAILABLE
 * + 티켓 CANCELLED + 누적 환불액 + 상태전이)은 commerce-client.refundOrder 에 위임한다.
 * go DB 의 좌석/order_items/products.stock 직접 갱신은 폐기(DROP 후 깨짐). PG 취소도 v2 가 소유.
 *
 * go orders 행은 thin 앵커 — v2 성공 후 status/refund_amount 를 **투영 캐시**로만 동기화.
 * V2CommerceError 는 상태코드 그대로 전파(미러 swallow 금지).
 */
/**
 * 환불 요청 본문.
 *
 * 종전에는 본문을 **아예 읽지 않았다** — 환불액은 정책이 정하므로 입력이 필요 없었다.
 * 예외 승인(입장객 환불)을 열면서 의사표시를 받아야 해 최소한으로 도입한다.
 * 본문 없음(=구버전 클라이언트)도 정상 동작한다 — 전부 optional 이다.
 */
const refundBodySchema = z.object({
  /** 입장 완료 티켓이 있어도 환불을 강행한다는 **명시 의사표시**. 기본 false. */
  allowAdmitted: z.boolean().optional(),
  /** 예외 승인 시 필수. 원장·감사에 남는다. */
  reason: z.string().min(1).max(300).optional(),
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  const pool = getPool();

  // 본문은 **선택**이다(없이 호출하던 기존 클라이언트 보존). 다만 보낸 본문이 스키마에
  // 안 맞으면 **조용히 버리지 않는다**.
  //
  // 🔴 2026-07-28 적대 감사 F-8: 종전엔 `if (parsed.success) body = parsed.data;` 로
  //    실패를 무시했다. `reason` 301자 + `allowAdmitted:true` 를 보내면 파싱이 실패해
  //    body 가 `{}` 가 되고, 결과는 409 "예외 승인으로 진행해주세요" — 운영자는 이미
  //    예외 승인을 보냈다고 생각한다. `allowAdmitted:"true"`(문자열)도 같은 식으로 증발했다.
  //    fail-closed 라 돈이 새진 않지만 **로그 한 줄 없이 입력을 버리는 것**은
  //    이 프로젝트에서 반복해서 사고를 만든 바로 그 유형이다.
  let body: z.infer<typeof refundBodySchema> = {};
  let rawBody: unknown;
  let hasBody = true;
  try {
    rawBody = await request.json();
  } catch {
    hasBody = false; // 본문 없음 — 정상. 기본값으로 진행.
  }
  if (hasBody) {
    const parsed = refundBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(parsed.error.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    body = parsed.data;
  }

  // ── W2-ORD: `INNER JOIN events`(starts_at) 제거 → v2 이벤트 조회로 분리 ──
  // 환불 정책(무료취소 기한 등)의 기준일은 v2 가 정본(event_date)이다. go events 를 JOIN 하면
  // 환불이라는 실돈 경로가 go events 존속에 묶인다.
  // 🔴 fail-closed: 기준일을 못 읽으면 정책 계산이 틀린다 — **환불을 진행하지 않고** 503.
  //   (없는 값으로 폴백하면 환불 수수료가 잘못 계산되어 돈이 틀어진다.)
  let eventStartsAt: string | null;
  try {
    const event = await getOwnedEvent(params.eventId, session.accountId);
    if (!event) return errorResponse(ERR.NOT_FOUND, 404);
    eventStartsAt = event.event_date;
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse("환불을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!eventStartsAt) {
    return errorResponse("행사 일시가 설정되지 않아 환불 정책을 계산할 수 없습니다", 409);
  }

  // go orders 행은 thin 앵커 — 소유검증(account_id 스코프) + v2_order_id 매핑 + 주문번호만 읽는다.
  // ⚠️ 이 go read 는 **제거 불가**: orders 행은 payment_confirm_outbox / 주문 상태머신의 기반이며
  //    v2_order_id 앵커가 여기에만 있다(보고서 §4 참조).
  // 결제액/누적환불액(환불 base SoT)은 go-local 컬럼이 아니라 getOrder(v2) 응답에서 읽는다.
  const orderResult = await pool.query<{
    status: OrderStatus;
    orderNumber: string;
    v2OrderId: string | null;
  }>(
    `
      SELECT
        orders.status,
        orders.order_number AS "orderNumber",
        orders.v2_order_id AS "v2OrderId"
      FROM orders
      WHERE orders.account_id = $1 AND orders.event_id = $2 AND orders.id = $3
      LIMIT 1
    `,
    [session.accountId, params.eventId, params.orderId],
  );

  let order = orderResult.rows[0];
  if (!order) {
    // 피켓(소비자)에서 결제한 주문은 go orders 행이 없다 — v2 에서 이 이벤트 주문인지 확인해 쓴다.
    // go 앵커 UPDATE(아래)는 0행이 되고, 상태·환불액 정본은 원래대로 v2 다.
    let v2Only: Awaited<ReturnType<typeof findV2OnlyOrder>>;
    try {
      v2Only = await findV2OnlyOrder(session.accountId, params.eventId, params.orderId);
    } catch (err: unknown) {
      if (err instanceof EventAccessError || err instanceof V2CommerceError) {
        return errorResponse("환불을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      throw err;
    }
    if (!v2Only) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }
    order = {
      status: v2Only.status as OrderStatus,
      orderNumber: v2Only.order_number,
      v2OrderId: v2Only.order_id,
    };
  }

  if (order.status !== "completed" && order.status !== "partially_refunded") {
    return errorResponse("현재 주문 상태에서는 환불할 수 없습니다", 400);
  }

  if (!order.v2OrderId) {
    return errorResponse("주문이 v2 와 연결되지 않아 환불할 수 없습니다 (v2_order_id 누락)", 409);
  }

  // 환불 base 산정 — v2 가 누적환불 SoT. go-local paid_amount/refund_amount 컬럼 read 폐기.
  let v2Order: Awaited<ReturnType<typeof getOrder>>;
  try {
    v2Order = await getOrder(order.v2OrderId);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 404 ORDER_NOT_FOUND 등 4xx 는 그대로, 5xx 는 502.
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      return errorResponse(err.message, status);
    }
    return errorResponse(ERR.SERVER, 500);
  }

  // 🔴 입장 완료 티켓은 환불 불가 — 돈이 움직이기 **전에** 막는다.
  //
  // 2026-07-28 prod E2E 에서 체크인해 `used` 가 된 티켓 2장이 그대로 환불돼 `cancelled` 이
  // 됐다. 관람을 마친 입장권을 환불하면 매출이 새고 재고까지 되돌아간다.
  // v2 `_do_refund_order` 에도 같은 불변식을 뒀지만 그쪽은 PG 취소가 끝난 뒤일 수 있어
  // 최후 방어선이다. **정본 게이트는 여기**다 — 여기서 막아야 부분성공이 생기지 않는다.
  //
  // 판정 데이터는 이미 손에 있다: `getOrder` 응답의 tickets[]가 status·checked_in_at 을 싣는다.
  // (v2 를 한 번 더 부르지 않는다 — 왕복이 늘면 여기와 실제 환불 사이 창이 넓어진다.)
  const admittedTickets = v2Order.tickets.filter(
    (t) => t.checked_in_at !== null || t.status === "used",
  );
  // ── 예외 승인 경로 (감사 F4) ────────────────────────────────────────────────
  //
  // 위 게이트는 맞지만, **빠져나갈 문이 없으면 그것대로 사고**다. 실제로 있는 상황들:
  //   · 우천·사고로 대회가 중단돼 입장객까지 전원 환불하기로 주최자가 결정한 경우
  //   · 가족 4장 중 1명만 입장했는데 나머지 3장을 환불해야 하는 경우
  // v2 는 `allow_admitted` 우회를 제공하는데 **호출자가 0** 이었다 — 정의만 있고 아무도
  // 켤 수 없어서, 운영자가 DB 를 직접 수술하는 것 외에 방법이 없었다.
  //
  // 그래서 **명시 의사표시**로만 열어준다:
  //   · `allowAdmitted: true` 를 본문에 넣어야 하고(기본 false — 실수로 켜지지 않는다)
  //   · `reason` 을 필수로 받는다(왜 입장객을 환불했는지가 원장에 남아야 한다)
  //   · 감사로그에 승인 사실·티켓수·사유를 박는다
  // 🔴 자동 경로(크론·보상 드레인)에서는 절대 켜지 않는다 — "주최자가 결정했다"는 근거가
  //    없기 때문이다. 그쪽은 manual_review 로 남긴다.
  const allowAdmitted = body.allowAdmitted === true;
  if (admittedTickets.length > 0 && !allowAdmitted) {
    return errorResponse(
      `이미 입장한 티켓이 ${admittedTickets.length}장 있어 환불할 수 없습니다. ` +
        `대회 중단 등으로 입장객까지 환불해야 한다면 사유와 함께 예외 승인으로 진행해주세요.`,
      409,
    );
  }
  if (allowAdmitted && !body.reason) {
    return errorResponse("입장객 환불 예외 승인은 사유가 필요합니다", 400);
  }

  // 환불 금액 산정(go 정책) — 이미 환불된 금액을 제외한 잔액 기준(전액기준 중복환불 방지).
  const refundableBase = v2Order.paid_amount - v2Order.total_refunded;
  const alreadyRefunded = v2Order.total_refunded;
  if (refundableBase <= 0) {
    return errorResponse("이미 전액 환불된 주문입니다", 400);
  }

  // 커스텀 환불 규칙 — 주문상세 표시와 동일 헬퍼로 조회(표시=적용 일치, 감사 P0-6).
  // ── W5-COMMERCE: 정책 정본이 go `refund_policies` → v2 `event_refund_policies` 로 이동 ──
  // 🔴 조회 실패를 "커스텀 정책 없음(=기본규칙)" 으로 흘리지 않는다. 커스텀 정책이 있는
  //    이벤트에서 기본규칙으로 환불하면 **실제 환불 금액이 달라진다**. 못 읽으면 환불을 멈춘다.
  // 🔴 2026-07-31 — 읽는 저장소를 바꿨다.
  //    종전: v2 `event_refund_policies`(getEventRefundRules). 그런데 **거기에 쓰는 화면이 없어서**
  //          prod 실측 0행이었고, 항상 `calculator.ts` 의 하드코딩 기본값으로 환불이 나갔다.
  //          ⟹ 주최자가 대시보드에서 정책을 아무리 고쳐도 지급액이 1원도 안 바뀌었다.
  //    지금: 대시보드가 실제로 저장하는 곳(v2 `events.cancellation_fee_tiers`)을 읽는다.
  //          공개 상세 표시(`policy-display.ts`)와 **같은 출처**라 표시=지급이 성립한다.
  let tiers: ReturnType<typeof toTiers>;
  try {
    const evt = await getEventForRefund(session.accountId, params.eventId);
    tiers = toTiers(evt.cancellation_fee_tiers);
  } catch (err: unknown) {
    const status = refundPolicyErrorStatus(err);
    if (status === null) throw err;
    return errorResponse(
      status === 404
        ? "이벤트를 찾을 수 없습니다."
        : "환불 정책을 확인할 수 없어 환불을 진행할 수 없습니다. 잠시 후 다시 시도해주세요.",
      status,
    );
  }

  const policy = toLegacyPreview(
    calculateCancellationRefund(tiers, eventStartsAt, refundableBase, new Date()),
  );

  if (!policy.canRefund) {
    return errorResponse("현재 시점에는 환불이 불가능합니다", 400);
  }

  // 취소 수수료가 없으면 잔액 전부 환불. 수수료가 있으면 지급액은 줄지만 주문 계약은
  // 전체 취소이므로 cancel_all 을 명시해 v2 가 티켓·좌석을 함께 해제한다.
  const isFull = policy.refundAmount >= refundableBase;

  let result: RefundOutcome;
  try {
    const refundReason = body.reason ?? "고객 요청 환불";
    result = await v2RefundOrder(
      order.v2OrderId,
      isFull
        ? { full: true, reason: refundReason, allow_admitted: allowAdmitted }
        : {
            amount: policy.refundAmount,
            cancel_all: true,
            reason: refundReason,
            allow_admitted: allowAdmitted,
          },
      // 멱등키 = 주문 + 목표 누적환불액 — 동일 환불 재시도 시 중복차단.
      { idempotencyKey: `go-refund:${params.orderId}:${alreadyRefunded + policy.refundAmount}` },
    );
  } catch (err: unknown) {
    // 🔴 타임아웃(기본 10초)으로 abort 돼도 v2 는 계속 실행·커밋할 수 있다.
    //    실패로 응답하기 전에 원장을 다시 읽어 **"사실은 성공"** 을 판별한다.
    //    이걸 안 하면 돈은 나갔는데 화면은 실패라고 말하는 split-brain 이 되고,
    //    아래 go 앵커 UPDATE 가 통째로 건너뛰어져 go 원장만 옛 상태로 남는다.
    //    구매자 즉시환불 경로(`api/public/refund/route.ts`)에는 이미 있는 방어인데
    //    주최자 경로에만 없었다(2026-08-03 배포본 대조에서 확인).
    // ⚠️ 성공 여부를 boolean 으로 들고 다니면 `result` 가 할당됐음을 타입체커가 증명하지
    //    못한다(TS2454). 복원값 자체를 nullable 로 두고 마지막에 한 번 대입한다.
    let recovered: RefundOutcome | null = null;
    try {
      const recheck = await getOrder(order.v2OrderId);
      if (recheck.total_refunded > v2Order.total_refunded) {
        // v2 는 실제로 환불했다. 실패로 접지 않고 정상 경로로 이어간다.
        // `refunded`·`seats_released` 는 이 아래에서 쓰이지 않는다 —
        // go 앵커 UPDATE 와 감사로그가 읽는 것은 status·total_refunded 뿐이다.
        recovered = {
          status: recheck.status,
          total_refunded: recheck.total_refunded,
          refunded: 0,
          seats_released: 0,
        };
        logger.warn("[refund] v2 응답 유실 — 원장 재조회로 성공 확인, 정상 처리 계속", {
          orderId: params.orderId,
          v2OrderId: order.v2OrderId,
          totalRefunded: recheck.total_refunded,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (recheckErr: unknown) {
      // 재조회도 실패 — 판별 불가. 아래에서 실패로 처리하되 근거를 남긴다.
      logger.error("[refund] 🔴 재조회 실패 — 환불 성사 여부 판별 불가. 수동 확인 필요", {
        orderId: params.orderId,
        v2OrderId: order.v2OrderId,
        amount: policy.refundAmount,
        error: recheckErr instanceof Error ? recheckErr.message : String(recheckErr),
      });
    }

    if (recovered === null) {
      if (err instanceof V2CommerceError) {
        // 4xx 는 사용자 에러(전이불가/이미환불 등), 5xx 는 일시 오류 → 502.
        const status =
          err.status === 422 ? 422 : err.status === 409 ? 409 : err.status >= 400 && err.status < 500 ? err.status : 502;
        return errorResponse(err.message, status);
      }
      return errorResponse(ERR.SERVER, 500);
    }
    result = recovered;
  }

  // go 앵커 동기화(표시 캐시) — v2 status 투영 + 누적 환불액. 좌석/재고는 v2 소유라 go 미갱신.
  await pool.query(
    `
      UPDATE orders
      SET
        status = $4,
        refund_amount = $5,
        payment_status = CASE WHEN $4 = 'refunded' THEN 'refunded' ELSE 'partially_refunded' END,
        updated_at = NOW()
      WHERE account_id = $1 AND event_id = $2 AND id = $3
    `,
    [session.accountId, params.eventId, params.orderId, projectToGoOrderStatus(result.status), result.total_refunded],
  );

  if (allowAdmitted) {
    logger.warn("[refund] 입장객 환불 예외 승인", {
      eventId: params.eventId,
      orderId: params.orderId,
      admittedTickets: admittedTickets.length,
      reason: body.reason,
      approvedBy: session.id,
    });
  }

  await logAudit({
    userId: session.id,
    accountId: session.accountId,
    action: "refund",
    tableName: "orders",
    recordId: params.orderId,
    changes: {
      refundAmount: policy.refundAmount,
      refundPercent: policy.refundPercent,
      policyLabel: policy.policyLabel,
      v2Status: result.status,
      totalRefunded: result.total_refunded,
      // 예외 승인은 **항상** 남긴다 — 입장객을 환불한 건은 사후에 근거를 물을 수 있어야 한다.
      ...(allowAdmitted
        ? {
            admittedRefundApproved: true,
            admittedTicketCount: admittedTickets.length,
            approvalReason: body.reason,
          }
        : {}),
    },
    ipAddress: auditClientIp(request.headers),
  });

  // P1-9: 실환불·go 투영·audit 는 이미 확정됨. webhook/알림은 부수효과라 실패해도
  // 환불 결과를 뒤집지 않는다. catch 없이 await 하면 발송 장애가 HTTP 500 으로 위장되어
  // 운영자가 완료된 환불을 재시도할 위험 → 개별 try/catch 로 격리.
  try {
    await dispatchWebhook("order.refunded", {
      eventId: params.eventId,
      orderId: params.orderId,
      refundAmount: policy.refundAmount,
      refundPercent: policy.refundPercent,
      policyLabel: policy.policyLabel,
    });
  } catch (err: unknown) {
    logger.error("[refund] order.refunded webhook 발송 실패 — 환불은 완료됨", {
      orderId: params.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await notifyRefundRequest(session.accountId, params.eventId, order.orderNumber);
  } catch (err: unknown) {
    logger.error("[refund] 환불 알림 발송 실패 — 환불은 완료됨", {
      orderId: params.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return successResponse(policy);
});

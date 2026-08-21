/**
 * POST /api/public/refund — 환불 신청 접수(공개, 구매자 지식 검증).
 *
 * ── 레벨2 컷오버 W2-PUB (부분 전환) ──
 * ✅ go `orders JOIN events` 앵커 조회 제거 → v2 `orders/by-external/{go order id}` +
 *    이벤트 상세(시작일). 구매자·결제액·누적환불액 SoT = v2.
 * 🔴 **미전환**: `refund_requests` 는 go DB 에 남아 있다.
 *    - v2 에 대응 테이블/엔드포인트가 없고,
 *    - `refund_requests.order_id` 는 go `orders(id)` FK 이며,
 *    - 같은 테이블을 `lib/server/order-finalize.ts`(타 트랙 소유)가 읽는다.
 *    한쪽만 옮기면 접수·처리가 서로 다른 저장소를 보는 split-brain 이 된다.
 *    ⟹ refund_requests 의 v2 이관은 order-finalize 트랙과 **한 배치로** 처리해야 한다.
 *
 * 실패 계약: 미존재/불일치 404 · v2 응답불가 503 · 중복 신청 409.
 */
import { cookies } from "next/headers";
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { notifyRefundRequest } from "@/lib/notifications/create";
import {
  matchesPublicLookup,
  PUBLIC_LOOKUP_COOKIE,
  verifyPublicLookupToken,
} from "@/lib/public-access";
import { calculateCancellationRefund, toLegacyPreview, toTiers } from "@/lib/refund/cancellation-fee";
import {
  V2CommerceError,
  getOrderByExternalRef,
  refundOrder as v2RefundOrder,
} from "@/lib/v2/commerce-client";
import { PUBLIC_ANY_STATUS, resolvePublicEventById } from "@/lib/v2/public-event";

const schema = z.object({
  orderId: z.string().uuid(),
  buyerEmail: z.email("올바른 이메일 형식을 입력해주세요"),
  buyerPhone: z.string().min(10, "전화번호를 입력해주세요"),
  reason: z.enum(["개인사정", "일정변경", "기타"]),
  reasonDetail: z.string().optional(),
});

async function refundHandler(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const lookup = verifyPublicLookupToken((await cookies()).get(PUBLIC_LOOKUP_COOKIE)?.value);

    // 주문 해석 — go order id(external_ref) → v2 주문(구매자·금액 SoT).
    let v2Order: Awaited<ReturnType<typeof getOrderByExternalRef>>;
    try {
      v2Order = await getOrderByExternalRef(body.orderId);
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status >= 400 && err.status < 500) {
          return errorResponse("주문 정보를 찾을 수 없습니다", 404);
        }
        return errorResponse(ERR.SERVER, 503);
      }
      return errorResponse(ERR.SERVER, 500);
    }

    const buyerEmail = v2Order.buyer.email;
    const buyerPhone = v2Order.buyer.phone;
    if (
      buyerEmail !== body.buyerEmail ||
      (buyerPhone ?? "") !== body.buyerPhone ||
      !matchesPublicLookup(lookup, { email: buyerEmail, phone: buyerPhone })
    ) {
      return errorResponse("주문 정보를 찾을 수 없습니다", 404);
    }
    const orderNumber = v2Order.order_number;

    const eventResolved = await resolvePublicEventById(v2Order.event_id, PUBLIC_ANY_STATUS);
    if (!eventResolved.ok) {
      return eventResolved.status === 404
        ? errorResponse("주문 정보를 찾을 수 없습니다", 404)
        : errorResponse(ERR.SERVER, 503);
    }
    const startsAt = eventResolved.event.event_date;
    if (!startsAt) {
      return errorResponse("이벤트 일정이 확정되지 않아 환불 규정을 계산할 수 없습니다", 409);
    }

    // 환불 base = 결제액 − 누적환불액(v2 SoT). 전액기준 중복환불 방지.
    const refundableBase = v2Order.paid_amount - v2Order.total_refunded;
    if (refundableBase <= 0) {
      return errorResponse("이미 전액 환불된 주문입니다", 400);
    }

    // 🔴 종전엔 정책 미전달 → 항상 하드코딩 기본값. 신청 원장의 `calculated_amount` 가
    //    주최자가 설정한 규정과 무관한 값으로 남았다(2026-07-31 발견).
    const preview = toLegacyPreview(
      calculateCancellationRefund(
        toTiers(eventResolved.event.cancellation_fee_tiers),
        startsAt,
        refundableBase,
        new Date(),
      ),
    );

    // 🔴 시점 가드 (2026-07-31). 종전엔 **없었다** — 환불 불가 시점(KLPGA 는 행사 당일
    //    00:00 KST 부터 수수료 100%)에도 0원짜리 신청이 `pending` 으로 접수되고
    //    "환불 신청이 접수되었습니다" 메일까지 나갔다. 그런데 주최자 경로
    //    (`events/[eventId]/orders/[orderId]/refund`)는 같은 조건을 400 으로 막는다
    //    ⟹ **접수는 되는데 처리는 불가능한 신청**이 쌓이고, 손님은 접수됐다고 믿고 기다린다.
    //
    //    같은 정책에서 두 경로의 판정이 갈라지면 안 된다. 문구·상태코드를 주최자 경로와
    //    같은 것으로 맞춘다.
    if (!preview.canRefund) {
      return errorResponse("현재 시점에는 환불이 불가능합니다", 400);
    }

    // ── 자동 집행 판정 (2026-08-01) ────────────────────────────────────────────
    //
    // 🔴 종전에는 `refund_requests` 에 pending 으로 적고 끝이었다. 그런데 **그 원장을 읽는
    //    코드도, 보는 화면도 리포에 없다**(크론 14개에도 없음). 손님은 "접수되었습니다" 를
    //    보고 기다리는데 우리는 신청이 온 사실조차 몰랐다 — 수동 운영이 아니라 **단절**이다.
    //    실제로 pending 2건이 방치돼 있었다(서로 다른 구매자, 각 15,000원).
    //
    // 전액환불 구간(수수료 0%)에서는 주최자가 판단할 여지가 없다. 거절할 수 없는 것을
    // 대기시키는 것은 지연만 만든다 ⟹ 즉시 집행한다(대표 결정).
    //
    // 자동은 **좁게** 연다. 아래를 전부 만족할 때만:
    const admittedTickets = v2Order.tickets.filter(
      (t) => t.checked_in_at !== null || t.status === "used",
    );
    // 🔴 전액 판정은 주최자 경로와 **같은 공식**이어야 한다
    //    (`events/[eventId]/orders/[orderId]/refund/route.ts` 의 isFull).
    const isFull = preview.refundAmount >= refundableBase;
    const autoEligible = isFull && admittedTickets.length === 0;

    // 🔴 입장한 티켓은 자동 환불하지 않는다. 관람을 마친 사람에게 돈이 나가는 사고를 막는다.
    //    v2 도 PG 호출 **전에** 같은 검사를 하므로(internal_commerce.py) 최후 방어는 v2 지만,
    //    여기서 막아야 사용자에게 이유를 말해줄 수 있다.
    if (admittedTickets.length > 0) {
      return errorResponse(
        "입장 확인된 티켓은 온라인 환불이 불가합니다. 고객센터로 문의해주세요",
        409,
      );
    }

    const pool = getPool();

    // 🔴 동시 제출 선점 — `refund_requests` 에는 UNIQUE 제약이 **없다**(실측: PK+FK 뿐).
    //    종전 `SELECT status='pending'` → INSERT 는 락 없는 check-then-act 라 두 탭에서
    //    동시에 누르면 둘 다 통과했다. 접수만 할 때는 행이 둘 생길 뿐이었지만,
    //    **즉시 집행이 되면 그 경합이 곧 이중 환불이다.**
    //    go `orders` 행을 잠가 같은 주문의 요청을 직렬화한다(마이그레이션 불필요).
    //    ⚠️ 2차 방어는 v2 — `with_for_update()` 로 주문을 잠그고 잔여액이 0이면 422 다.
    //       단 그 보호는 **전액환불에만** 성립한다(부분은 갱신된 잔여액으로 재검증을 통과).
    const client = await pool.connect();
    let outcome: "completed" | "failed" | "pending" = "pending";
    let refundStatusForGo: string | null = null;
    let totalRefunded = 0;
    // 🔴 롤백 여부를 **상태로** 들고 간다 (2026-08-01 배포 검수에서 실증).
    //    `try { BEGIN ... } finally { release }` 만 두면, BEGIN~COMMIT 사이에서 예외가
    //    날 때 **롤백 없이 커넥션이 풀로 반납된다.** `pg` 는 반납 시 자동 롤백을 하지 않는다.
    //    로컬 실증(pg 8.20, max:1): 같은 커넥션(pid 807)이 재사용되고 **미커밋 INSERT 1행이
    //    그대로 살아 있었다** — 다음에 들어온 무관한 요청이 그 열린 트랜잭션 안에서 돈다.
    //    게다가 위 `FOR UPDATE` 로 잡은 **주문 행 잠금이 안 풀려** 그 주문의 후속 처리가 멈춘다.
    //    ⟹ 리포의 확립된 패턴을 따른다(`lib/payment/webhook.ts` 의 catch/finally).
    //    ⚠️ COMMIT 이후 구간(v2 집행·투영)까지 같은 try 안에 있으므로, 트랜잭션이 이미 닫혔는지
    //       플래그로 구분한다. 닫힌 뒤 ROLLBACK 을 쏘면 "no transaction in progress" 경고만
    //       남기고 조용히 지나가 **진짜 누출을 가린다.**
    let txOpen = false;
    try {
      await client.query("BEGIN");
      txOpen = true;
      const locked = await client.query<{ id: string; account_id: string; event_id: string }>(
        `SELECT id, account_id, event_id FROM orders WHERE id = $1 FOR UPDATE`,
        [body.orderId],
      );
      if (locked.rows.length === 0) {
        await client.query("ROLLBACK");
        txOpen = false;
        return errorResponse("주문 정보를 찾을 수 없습니다", 404);
      }
      const goOrder = locked.rows[0];

      const dup = await client.query<{ id: string }>(
        `SELECT id FROM refund_requests
          WHERE order_id = $1 AND status IN ('pending', 'processing')
          LIMIT 1`,
        [body.orderId],
      );
      if (dup.rows.length > 0) {
        await client.query("ROLLBACK");
        txOpen = false;
        return errorResponse("이미 접수된 환불 요청이 있습니다", 409);
      }

      // 원장 먼저 — 프로세스가 죽어도 흔적이 남는다.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO refund_requests (
           id, order_id, reason, reason_detail, calculated_amount, status, created_at
         ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [
          body.orderId,
          body.reason,
          body.reasonDetail ?? null,
          preview.refundAmount,
          autoEligible ? "processing" : "pending",
        ],
      );
      const requestId = inserted.rows[0].id;
      await client.query("COMMIT");
      txOpen = false;

      if (!autoEligible) {
        // 자동 조건 미충족(부분환불 등) — 종전대로 접수만 하고 주최자에게 알린다.
        // 🔴 알림 실패가 환불 결과를 뒤집으면 안 된다. `.catch()` 체인은 반환이 Promise 가
        //    아니면 TypeError 로 터져 500 이 된다 — try/catch 로 확실히 삼킨다.
        try {
          await notifyRefundRequest(goOrder.account_id, goOrder.event_id, orderNumber);
        } catch (err: unknown) {
          logger.error("[public-refund] 접수 알림 실패", {
            requestId, error: err instanceof Error ? err.message : "unknown",
          });
        }
        return successResponse({
          refundAmount: preview.refundAmount,
          refundPercent: preview.refundPercent,
          policyLabel: preview.policyLabel,
          status: "pending",
        }, 201);
      }

      // ── 즉시 집행 ──────────────────────────────────────────────────────────
      // 🔴 `full: true` 만 보낸다. `amount` 를 **절대 보내지 않는다.**
      //    v2 의 주문 락은 전액환불만 이중집행을 막아준다. 부분환불은 직렬화 후에도
      //    갱신된 잔여액으로 재검증을 통과해 **같은 델타가 두 번 나간다**
      //    (commerce-client.ts 의 `retries: 0` 주석 참조). 이것이 돈의 마지막 방어선이다.
      // 🔴 `allow_admitted` 는 넘기지 않는다 — 입장자 환불 강행이 된다. 자동 경로에는
      //    "주최자가 결정했다"는 근거가 없다.
      // 🔴 첫 인자는 **v2 canonical order_id** 다. go order id 를 넘기면 404 다.
      try {
        const result = await v2RefundOrder(
          v2Order.order_id,
          { full: true, reason: `구매자 자가환불: ${body.reason}` },
          // 멱등키는 주최자 경로와 같은 규칙 — 두 경로가 같은 키로 수렴한다.
          { idempotencyKey: `go-refund:${body.orderId}:${preview.refundAmount}` },
        );
        outcome = "completed";
        refundStatusForGo = result.status;
        totalRefunded = result.total_refunded;
      } catch (err: unknown) {
        // 🔴 타임아웃(기본 10초)으로 abort 돼도 v2 는 계속 실행·커밋할 수 있다.
        //    `failed` 로 적기 전에 원장을 다시 읽어 **"사실은 성공"** 을 판별한다.
        //    이걸 안 하면 돈은 나갔는데 화면은 실패라고 말하는 split-brain 이 된다.
        let actuallySucceeded = false;
        try {
          const recheck = await getOrderByExternalRef(body.orderId);
          actuallySucceeded = recheck.total_refunded > v2Order.total_refunded;
          if (actuallySucceeded) {
            refundStatusForGo = recheck.status;
            totalRefunded = recheck.total_refunded;
          }
        } catch {
          // 재조회도 실패 — 판별 불가. 아래에서 실패로 처리하되 manual_review 로 남긴다.
        }
        outcome = actuallySucceeded ? "completed" : "failed";
        if (!actuallySucceeded) {
          logger.error("[public-refund] 🔴 즉시환불 실패 — 수동 확인 필요", {
            requestId,
            orderNumber,
            goOrderId: body.orderId,
            v2OrderId: v2Order.order_id,
            amount: preview.refundAmount,
            error: err instanceof Error ? err.message : "unknown",
          });
        }
      }

      // 결과 기록 — 실패는 `manual_review`. `failed` 로 두면 재제출이 무한 자동 재집행이 된다.
      await pool.query(
        `UPDATE refund_requests SET status = $2 WHERE id = $1`,
        [requestId, outcome === "completed" ? "completed" : "manual_review"],
      );

      if (outcome === "completed") {
        // go 앵커 투영 — 주최자 경로(`:249-260`)와 같은 컬럼.
        // ⚠️ 투영 실패가 **환불 성립을 뒤집지 않는다** — 돈은 이미 나갔다. 로그만 남긴다.
        try {
        await pool.query(
          `UPDATE orders
              SET status = 'refunded',
                  refund_amount = $2,
                  payment_status = 'refunded',
                  updated_at = NOW()
            WHERE id = $1`,
          [body.orderId, totalRefunded],
        );
        } catch (err: unknown) {
          logger.error("[public-refund] go 투영 실패(환불은 성립)", {
            requestId, error: err instanceof Error ? err.message : "unknown",
          });
        }

        return successResponse({
          refundAmount: preview.refundAmount,
          refundPercent: preview.refundPercent,
          policyLabel: preview.policyLabel,
          status: "completed",
          v2Status: refundStatusForGo,
        }, 200);
      }

      // 🔴 실패를 성공으로 위장하지 않는다. 그리고 **실재하는 채널**로만 알린다 —
      //    go 에는 텔레그램·슬랙이 없고, 메일은 미설정 시 throw 한다. 인앱 알림이 유일하다.
      try {
        await notifyRefundRequest(goOrder.account_id, goOrder.event_id, orderNumber);
      } catch (e: unknown) {
        logger.error("[public-refund] 실패 알림도 실패", {
          requestId, error: e instanceof Error ? e.message : "unknown",
        });
      }
      return errorResponse("환불 처리에 실패했습니다. 고객센터로 문의해주세요", 502);
    } catch (txErr: unknown) {
      // 🔴 여기가 없으면 커넥션이 **열린 트랜잭션째** 풀로 돌아간다(위 주석의 실증 참조).
      //    ROLLBACK 자체가 실패해도(커넥션 단절 등) 원래 예외를 삼키면 안 된다.
      if (txOpen) {
        try {
          await client.query("ROLLBACK");
        } catch (rbErr: unknown) {
          logger.error("[public-refund] 🔴 ROLLBACK 실패 — 커넥션 오염 가능", {
            goOrderId: body.orderId,
            error: rbErr instanceof Error ? rbErr.message : "unknown",
          });
        }
        txOpen = false;
      }
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 5,
  windowMs: 60_000,
  keyPrefix: "public:refund",
})(refundHandler);

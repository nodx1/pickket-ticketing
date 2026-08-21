import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { projectToGoOrderStatus } from "@/lib/domain-model";
import { refundOrderItems, V2CommerceError } from "@/lib/v2/commerce-client";
import { auditClientIp } from "@/lib/request-ip";

type Params = { eventId: string; orderId: string };

const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update_attendee"),
    attendeeId: z.string().uuid(),
    name: z.string().min(2).optional(),
    email: z.email().optional().or(z.literal("")),
    phone: z.string().optional(),
  }),
  z.object({
    // 라인(티켓) 단위 취소. v2 라인취소 = 티켓 단위이므로 attendeeId(=go 참석자=1티켓) 를 받아
    // 그 참석자의 v2_ticket_id 로 v2 부분환불을 호출한다.
    type: z.literal("cancel_item"),
    attendeeId: z.string().uuid(),
  }),
]);

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());
    const pool = getPool();

    if (body.type === "update_attendee") {
      const result = await pool.query(
        `
          UPDATE attendees
          SET
            name = COALESCE($4, name),
            email = COALESCE($5, email),
            phone = COALESCE($6, phone),
            updated_at = NOW()
          WHERE id = $1 AND order_id = $2 AND account_id = $3
          RETURNING id, name, email, phone
        `,
        [
          body.attendeeId,
          params.orderId,
          session.accountId,
          body.name ?? null,
          body.email ?? null,
          body.phone ?? null,
        ],
      );

      if (result.rows.length === 0) {
        return errorResponse(ERR.NOT_FOUND, 404);
      }

      await logAudit({
        userId: session.id,
        accountId: session.accountId,
        action: "update",
        tableName: "attendees",
        recordId: body.attendeeId,
        changes: {
          name: body.name ?? null,
          email: body.email ?? null,
          phone: body.phone ?? null,
        },
        ipAddress: auditClientIp(request.headers),
      });

      return successResponse(result.rows[0]);
    }

    // ── cancel_item: 라인(티켓) 단위 취소 = v2 부분환불(PartialRefundService) write-through ──────
    // v2 라인취소는 ticket 단위다. go 참석자(attendee) 1행 = v2 티켓 1개(v2_ticket_id) 이므로
    // attendeeId 로 대상 티켓을 특정한다. 재고환원·좌석 release·티켓 CANCELLED·부분환불·주문상태전이는
    // v2 가 원자로 수행(SoT). go 는 v2 성공 후 참석자 상태만 cancelled 로 투영한다.
    // ⚠️ v2 backend 선행 배포 필요 — refund-items 미배포 시 v2 가 404/501 → 아래에서 사용자 문구로 폴백.
    const { rows: attendeeRows } = await pool.query<{
      id: string;
      v2TicketId: string | null;
      status: string;
      v2OrderId: string | null;
    }>(
      `
        SELECT a.id, a.v2_ticket_id AS "v2TicketId", a.status,
               o.v2_order_id AS "v2OrderId"
        FROM attendees a
        JOIN orders o ON o.id = a.order_id
        WHERE a.id = $1 AND a.order_id = $2 AND a.account_id = $3
        LIMIT 1
      `,
      [body.attendeeId, params.orderId, session.accountId],
    );
    const attendee = attendeeRows[0];
    if (!attendee) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }
    if (attendee.status === "cancelled") {
      return errorResponse("이미 취소된 항목입니다", 409);
    }
    if (!attendee.v2OrderId || !attendee.v2TicketId) {
      // v2 앵커 미연결(레거시 주문 등) — 라인 취소 대상 아님. 전체 환불을 안내.
      return errorResponse(
        "이 항목은 라인 단위 취소를 지원하지 않습니다 (v2 티켓 연결 없음). 전체 환불을 사용하세요.",
        422,
      );
    }

    let v2Result: Awaited<ReturnType<typeof refundOrderItems>>;
    try {
      // 멱등키 = 주문+티켓 단위 → 동시 2회 실행/재시도 시 v2 가 중복환불 차단.
      v2Result = await refundOrderItems(
        attendee.v2OrderId,
        { items: [{ ticket_id: attendee.v2TicketId }], reason: "organizer_line_cancel" },
        { idempotencyKey: `go-refund-item:${attendee.v2OrderId}:${attendee.v2TicketId}` },
      );
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        logger.warn("라인 취소 v2 부분환불 실패", {
          orderId: params.orderId,
          attendeeId: attendee.id,
          status: err.status,
        });
        // v2 미배포(404/501) 또는 정책거부(422) — 부분커밋 금지, go 투영 미변경. 사용자 문구로 폴백.
        if (err.status === 404 || err.status === 501) {
          return errorResponse(
            "라인 단위 취소가 아직 활성화되지 않았습니다 (v2 배포 대기). 전체 환불을 사용하세요.",
            501,
          );
        }
        return errorResponse(err.message || "라인 취소에 실패했습니다", 422);
      }
      throw err;
    }

    // v2 성공 후에만 go 참석자 상태를 cancelled 로 투영(가드: 이미 cancelled 아님).
    // 이 UPDATE 의 rowCount 를 go-side 멱등 토큰으로 쓴다 — 동시 2회/재시도로 v2 가
    // 같은 응답을 재생하더라도 아래 refund_amount 가산은 "참석자 전이 승자" 1회만 수행된다.
    const attendeeUpdate = await pool.query(
      `UPDATE attendees SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND account_id = $2 AND status <> 'cancelled'`,
      [attendee.id, session.accountId],
    );
    const transitionedNow = (attendeeUpdate.rowCount ?? 0) > 0;

    // 주문 상태(부분/전체 환불)는 v2 SoT → go orders 앵커에 투영. status/payment_status 는
    // 항상 최신값으로 맞추되(멱등), 누적 환불액 가산은 이번 호출이 실제 전이 승자일 때만 수행.
    await pool.query(
      `
        UPDATE orders
        SET
          status = $3,
          refund_amount = COALESCE(refund_amount, 0) + CASE WHEN $5 THEN $4 ELSE 0 END,
          payment_status = CASE WHEN $3 = 'refunded' THEN 'refunded' ELSE 'partially_refunded' END,
          updated_at = NOW()
        WHERE id = $1 AND account_id = $2
      `,
      [params.orderId, session.accountId, projectToGoOrderStatus(v2Result.status), v2Result.refunded, transitionedNow],
    );

    await logAudit({
      userId: session.id,
      accountId: session.accountId,
      action: "refund",
      tableName: "attendees",
      recordId: attendee.id,
      changes: {
        kind: "line_cancel",
        v2TicketId: attendee.v2TicketId,
        refunded: v2Result.refunded,
        orderStatus: v2Result.status,
      },
      ipAddress: auditClientIp(request.headers),
    });

    return successResponse({
      attendeeId: attendee.id,
      status: v2Result.status,
      refunded: v2Result.refunded,
      seatsReleased: v2Result.seats_released,
      cancelledTicketIds: v2Result.cancelled_ticket_ids,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse("주문을 수정하지 못했습니다", 400);
  }
});

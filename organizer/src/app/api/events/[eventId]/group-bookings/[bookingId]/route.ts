/**
 * 단체예약 상세·승인/거절 — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * go `group_bookings`(+ `products` JOIN)를 v2 로 옮겼다. go `orders` 앵커 읽기는 유지한다
 * (주문 앵커는 주문 트랙 소유 — 여기서는 취소 경로에 필요한 status/v2_order_id 만 읽는다).
 *
 * ## 상태 전이는 v2 가 원자 집행한다
 * 옛 go 는 `SELECT status` → 분기 → `UPDATE` 였다(감사 P0-9 가드). 동시에 두 번 승인하면
 * 둘 다 pending 을 읽고 둘 다 통과한다. 이제 v2 가 `FOR UPDATE` 로 잠그고 판정하므로 하나만
 * 통과한다. go 쪽 사전 체크는 **주문을 만들기 전에 빨리 끊기 위한 것**일 뿐 최종 판정이 아니다.
 * (주문 자체는 `createOrder` 의 결정적 멱등키 `group-booking:{event}:{booking}` 로 이미
 *  중복이 봉쇄돼 있어, 사전 체크와 v2 판정 사이에 레이스가 나도 주문은 1건이다.)
 *
 * ## 🔴 승인 금액
 * 단가는 v2 티어(`product_price`)가 정본이다. 티어가 사라져 `null` 이면 **0원으로 승인하지
 * 않는다** — 409 로 끊는다. 0원 주문은 되돌리기 어려운 금전 사고다.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { projectToGoOrderStatus } from "@/lib/domain-model";
import { createOrder } from "@/lib/server/orders";
import { requireFeature } from "@/lib/server/require-feature";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import {
  cancelOrder as v2CancelOrder,
  getGroupBooking,
  patchGroupBooking,
  refundOrder as v2RefundOrder,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { requireOwnedEvent } from "@/lib/v2/event-access";

type Params = { eventId: string; bookingId: string };

const schema = z.object({
  status: z.enum(["confirmed", "cancelled"]),
  discountRate: z.number().min(0).max(100).optional(),
  rejectionReason: z.string().optional(),
});

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  const featureBlock = await requireFeature(params.eventId, session.accountId, "group_booking");
  if (featureBlock) return featureBlock;
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const booking = await getGroupBooking(event.event_id, params.bookingId);
    return successResponse({
      id: booking.booking_id,
      event_id: booking.event_id,
      product_id: booking.product_ref,
      order_id: booking.order_ref,
      organization_name: booking.organization_name,
      contact_name: booking.contact_name,
      contact_email: booking.contact_email,
      contact_phone: booking.contact_phone,
      attendee_count: booking.attendee_count,
      discount_rate: booking.discount_rate,
      notes: booking.notes,
      rejection_reason: booking.rejection_reason,
      approved_at: booking.approved_at,
      status: booking.status,
      created_at: booking.created_at,
      productName: booking.product_name,
      productPrice: booking.product_price,
    });
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "단체 예약을 찾을 수 없습니다",
      unavailableMessage: "단체 예약을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId: params.eventId, bookingId: params.bookingId },
    });
    if (mapped) return mapped;
    throw err;
  }
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  const featureBlock = await requireFeature(params.eventId, session.accountId, "group_booking");
  if (featureBlock) return featureBlock;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("입력값을 확인해주세요", 400);
  }

  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const booking = await getGroupBooking(event.event_id, params.bookingId);

    // 사전 가드 — v2 가 최종 판정하지만, 주문을 만들기 전에 여기서 먼저 끊는다.
    if (body.status === "confirmed" && booking.status === "confirmed") {
      return errorResponse("이미 승인된 단체 예약입니다", 409);
    }
    if (body.status === "confirmed" && booking.status === "cancelled") {
      return errorResponse("이미 거절된 단체 예약은 다시 승인할 수 없습니다", 409);
    }
    if (body.status === "cancelled" && booking.status === "cancelled") {
      return errorResponse("이미 거절된 단체 예약입니다", 409);
    }

    if (body.status === "cancelled") {
      const pool = getPool();
      // 이미 확정되어 v2 주문이 연결된 경우: v2 원자 환불/취소 먼저(좌석 release + 티켓 CANCELLED).
      // go 에서 직접 좌석/티켓 취소 금지(원자성=v2 소유).
      if (booking.order_ref) {
        const { rows } = await pool.query<{ status: string; v2_order_id: string | null }>(
          `SELECT status, v2_order_id FROM orders WHERE id = $1 AND account_id = $2 LIMIT 1`,
          [booking.order_ref, session.accountId],
        );
        const order = rows[0];
        if (order?.v2_order_id) {
          const reason = body.rejectionReason ?? "단체 예약 취소";
          try {
            if (order.status === "completed" || order.status === "partially_refunded") {
              // 결제완료(offline paid) → 전액 환불.
              const r = await v2RefundOrder(
                order.v2_order_id,
                { full: true, reason },
                { idempotencyKey: `go-refund:${booking.order_ref}:groupbooking` },
              );
              await pool.query(
                `UPDATE orders SET status = $2, refund_amount = $3, updated_at = NOW() WHERE id = $1`,
                [booking.order_ref, projectToGoOrderStatus(r.status), r.total_refunded],
              );
            } else {
              // 미결제 주문 → 취소.
              const c = await v2CancelOrder(
                order.v2_order_id,
                { reason },
                { idempotencyKey: `go-cancel:${booking.order_ref}:groupbooking` },
              );
              await pool.query(
                `UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1`,
                [booking.order_ref, projectToGoOrderStatus(c.status)],
              );
            }
          } catch (err: unknown) {
            if (err instanceof V2CommerceError) {
              const status = err.status >= 400 && err.status < 500 ? (err.status === 422 ? 422 : 409) : 502;
              return errorResponse(err.message, status);
            }
            throw err;
          }
        }
      }

      // 예약 상태/사유 기록(환불·취소 성공 후에만).
      await patchGroupBooking(event.event_id, params.bookingId, {
        status: "cancelled",
        rejection_reason: body.rejectionReason ?? "관리자 거절",
      });
      return successResponse({ cancelled: true });
    }

    // ── 승인 ──
    // 🔴 단가는 v2 티어가 정본. 티어가 사라졌으면 0원 승인이 아니라 거부다.
    if (booking.product_price === null) {
      return errorResponse(
        "상품 정보를 확인할 수 없어 승인할 수 없습니다. 상품을 다시 확인해주세요.",
        409,
      );
    }
    const discountRate = body.discountRate ?? 0;
    const originalAmount = booking.product_price * booking.attendee_count;
    const discountedAmount = Math.max(Math.round(originalAmount * (1 - discountRate / 100)), 0);

    const order = await createOrder({
      accountId: session.accountId,
      eventId: params.eventId,
      buyerName: booking.contact_name,
      buyerEmail: booking.contact_email,
      buyerPhone: booking.contact_phone ?? undefined,
      items: [{ productId: booking.product_ref, quantity: booking.attendee_count }],
      paymentMethod: "offline",
      status: "completed",
      paymentStatus: "paid",
      paidAmount: discountedAmount,
      totalAmountOverride: discountedAmount,
      // 결정적 멱등키 — 재승인/동시승인이 같은 v2 주문을 재생한다(중복 발권 차단).
      idempotencyToken: `group-booking:${params.eventId}:${params.bookingId}`,
    });

    // 주문 생성 후 예약 확정. 여기서 실패하면 예약은 pending 으로 남고, 재시도가 같은 주문을
    // 멱등 재생하므로 중복 주문 없이 복구된다(부분커밋이 금전 사고로 번지지 않는 순서).
    await patchGroupBooking(event.event_id, params.bookingId, {
      status: "confirmed",
      discount_rate: discountRate,
      order_ref: order.id,
      order_number: order.orderNumber,
      approved_by_ref: session.id,
    });

    return successResponse({ confirmed: true, orderId: order.id, orderNumber: order.orderNumber });
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "단체 예약을 찾을 수 없습니다",
      unavailableMessage: "단체 예약을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
      conflictMessage: "단체 예약 상태가 이미 변경되었습니다. 새로고침 후 다시 확인해주세요.",
      context: { eventId: params.eventId, bookingId: params.bookingId },
    });
    if (mapped) return mapped;
    return errorResponse(
      err instanceof Error ? err.message : "단체 예약 처리에 실패했습니다",
      500,
    );
  }
});

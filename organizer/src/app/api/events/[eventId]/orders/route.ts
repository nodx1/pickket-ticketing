import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { createOrder } from "@/lib/server/orders";
import { listOrders, V2CommerceError } from "@/lib/v2/commerce-client";
import { paymentAttemptView } from "@/lib/orders/payment-attempt-label";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";
import { requireIdempotencyKey } from "@/lib/server/idempotency";

type Params = { eventId: string };

const manualOrderSchema = z.object({
  buyerName: z.string().min(2, "구매자 이름은 2자 이상이어야 합니다"),
  buyerEmail: z.email("올바른 이메일 형식을 입력해주세요"),
  buyerPhone: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().min(1),
    }),
  ).min(1, "주문 상품을 선택해주세요"),
});

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const GET = withRole<Params>("organizer", async (request, { session, params }) => {
  // 빅뱅 flip D — go DB JOIN → v2 live read(주문 SoT=v2). 매출/net 은 행 단위 계산.
  const { searchParams } = new URL(request.url);
  const page = parsePositiveInt(searchParams.get("page"), 1);
  const limit = Math.min(parsePositiveInt(searchParams.get("limit"), 20), 100);
  const status = searchParams.get("status")?.trim();
  const q = searchParams.get("q")?.trim() || undefined;
  /**
   * 🔴 초대권·수동발권을 실판매와 갈라 보는 필터 — **서버가 자른다.**
   *    클라이언트에서 자르면 페이지네이션과 총계가 어긋나 발주처가 잘못 센다.
   * ⚠️ 아는 값만 통과시킨다. 오타를 그대로 넘기면 v2 가 무시하고 **조용히 전체**가 나온다.
   */
  const rawSource = searchParams.get("issueSource")?.trim();
  const issueSource = rawSource === "sale" || rawSource === "issued" ? rawSource : undefined;
  const offset = (page - 1) * limit;
  // go 6-상태 그대로 전달 — v2 가 역투영. 미지원 status 는 v2 가 빈 목록 반환.
  const statusParam =
    status && ["pending", "completed", "cancelled", "refunded", "partially_refunded"].includes(status)
      ? status
      : undefined;
  // q = order_number(external_ref)/buyer 검색 — v2 §14 가 서버측 위임 처리.

  try {
    // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
    // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found → 빈 목록).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    // 없거나 내 계정 소유가 아님 → 목록류이므로 빈 목록 폴백(기존 동작 보존).
    if (!v2EventId) {
      return listResponse([], 0, page, limit, { issueSource: null });
    }
    const r = await listOrders(v2EventId, { status: statusParam, q, limit, offset, issueSource });
    const rows = r.orders.map((o) => ({
      // 🔴 2026-07-27 prod 실결함: 여기가 `o.order_id`(v2 id)를 내려보내고 있었다.
      //    그런데 주문 **상세·환불 라우트는 go order id** 로 조회한다(go orders 앵커가
      //    v2_order_id 매핑과 소유검증을 들고 있기 때문). 목록 화면은 이 id 로 링크를 만들므로
      //    ⟹ **주문 상세·환불이 전부 404** 였다(실측: v2 id → 404, go id → 200).
      //    external_ref 가 곧 go order id 다. 없으면(v2 네이티브 주문) v2 id 로 폴백한다.
      id: o.external_ref ?? o.order_id,
      // v2 보장: order_number = external_ref ?? order_id (null 없음).
      orderNumber: o.order_number,
      buyerName: o.buyer_name,
      buyerEmail: o.buyer_email,
      totalAmount: o.total_amount,
      // 실결제액 = v2 청구 total.
      paidAmount: o.paid_amount,
      refundedAmount: o.total_refunded,
      // ⛔ `netAmount` 를 여기에 되살리지 말 것 (지시서 #4 T11).
      //    예전엔 `netAmount: o.total_amount - o.total_refunded` 를 내려보냈다. 이름은
      //    "순액"인데 **수수료가 빠져 있지 않아** 정산액이 아니었다. 이 리포의 다른 모든
      //    `netAmount`(주문 상세 `detail.net_amount`, `Settlement.netAmount`)는 수수료를
      //    제외한 값이라, 같은 이름이 두 가지를 뜻하는 상태였다 —
      //    다음 사람이 이걸 정산액으로 오해하고 배선할 위험이 실제 위험이었다.
      //    실측 소비자 0곳이라 제거했다. 환불 반영 총액이 필요하면 호출측에서
      //    `totalAmount - refundedAmount` 로 계산하라(둘 다 위에 있다).
      //    진짜 정산액이 필요하면 v2 단건 read 의 `net_amount`(수수료 차감분)를 써야 한다 —
      //    v2 주문 **목록** 응답(OrderListRow)에는 그 값이 없다.
      status: o.status, // 이미 go 6-상태 투영
      // 🔴 「결제창 이탈」과 「결제 실패」 — 상태(status)는 건드리지 않고 표시만 더한다.
      //    ⚠️ v2 원문(last_error)은 내려보내지 않는다. 분류로 만든 문구만 준다.
      paymentAttempt: paymentAttemptView(o.payment_attempts, o.status),
      // 🔴 초대권·수동발권 구분 — 없으면 목록에서 실판매와 섞여 매출이 부풀어 보인다
      //    (확정 27건이 결제 시도 0건이었다). 판정·문구는 `@/lib/orders/issue-source`.
      // ⚠️ `undefined` 를 `false` 로 접지 않는다 — 「모름」과 「아님」은 다르다.
      isInvitation: o.is_invitation,
      isManualIssue: o.is_manual_issue,
      orderedAt: o.ordered_at,
    }));
    /**
     * 🔴 **v2 가 실제로 적용한 값**을 그대로 올린다(우리가 보낸 값이 아니다).
     *    화면은 이 값과 자기 선택을 대조해 「필터가 안 먹었다」를 알아챈다 —
     *    없으면 원천이 무시할 때 조용히 전체가 나오고, 그걸 「실판매 N건」으로 읽는다.
     * ⚠️ 구버전 v2 는 이 키가 없다 → `null` 로 내려가고, 화면이 그것도 미적용으로 읽는다.
     */
    return listResponse(rows, r.total, page, limit, {
      issueSource: r.issue_source ?? null,
    });
  } catch (err: unknown) {
    // 소유 확인 자체가 불가한 v2 장애를 "주문 0건"으로 위장하지 않는다(빈 목록 폴백 대상 아님).
    if (err instanceof EventAccessError) {
      return errorResponse("주문 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      // 404 = 이벤트에 주문 원장이 없음 → 빈 목록이 사실이다.
      if (err.status === 404) return listResponse([], 0, page, limit, { issueSource: null });
      // 🔴 W2-ORD fail-closed: 여기 있던 "화면 비파괴 — 빈 목록 폴백"은 **장애 은폐**였다.
      //   주문 목록의 0건은 주최자에게 "주문이 없다"로 읽힌다 — v2 가 죽어서 못 읽은 것과
      //   구분이 안 되면 환불/정산 판단을 잘못하게 된다. 장애는 장애로 표시한다.
      return errorResponse("주문 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse(err instanceof Error ? err.message : ERR.SERVER, 500);
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = manualOrderSchema.parse(await request.json());
    const idempotencyToken = requireIdempotencyKey(request);
    const result = await createOrder({
      accountId: session.accountId,
      eventId: params.eventId,
      buyerName: body.buyerName,
      buyerEmail: body.buyerEmail,
      buyerPhone: body.buyerPhone,
      items: body.items,
      paymentMethod: "offline",
      status: "completed",
      paymentStatus: "paid",
      idempotencyToken,
    });

    return successResponse(result, 201);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    // W2-ORD fail-closed: 수동 주문 생성도 v2 장애를 400 으로 위장하지 않는다.
    if (err instanceof EventAccessError) {
      return err.reason === "not_found"
        ? errorResponse(ERR.NOT_FOUND, 404)
        : errorResponse("주문을 생성하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError && err.status >= 500) {
      return errorResponse("주문을 생성하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof Error) {
      return errorResponse(err.message, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

import { withAuth } from "@/lib/auth/withAuth";
// W3-MSG 잔여 go DB: attendees·orders — 수동 발권이 go 참석자 원장을 쓴다. 참석자 v2 이관 트랙 종속.
import { getPool } from "@/lib/db/pool";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { createOrder, V2CommerceError } from "@/lib/server/orders";
import { requireFeature } from "@/lib/server/require-feature";
import { ensureCompProduct } from "@/lib/server/rsvp-product";
import { requireIdempotencyKey } from "@/lib/server/idempotency";
import { auditClientIp } from "@/lib/request-ip";

type Params = { eventId: string };

export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "ticket_issuance");
  if (featureBlock) return featureBlock;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT a.id, a.ticket_number AS "ticketNumber", a.name, a.email, a.phone,
            a.status, a.created_at AS "createdAt",
            a.raffle_number AS "raffleNumber",
            o.order_number AS "orderNumber", o.memo
     FROM attendees a
     JOIN orders o ON o.id = a.order_id
     WHERE a.event_id = $1 AND a.account_id = $2
       AND o.payment_method = 'offline'
       -- 🔴 상태 필터가 **없었다** (2026-08-01 실사고).
       --    checkout/initiate 가 모든 소비자 주문을 payment_method='offline' 로 적기
       --    때문에(카드 포함), 카드 결제하다 이탈해 **취소된 사람이 이 명단에 떠 있었다.**
       --    prod 에서 4명이 실제로 떠 있었다(참석자 cancelled · 주문 expired).
       --    대회 당일 이 명단을 보고 **결제 안 한 사람에게 발권**할 수 있다.
       --
       -- ⚠️ partially_refunded 를 빼면 안 된다. completed → partially_refunded 는 합법
       --    전이이고(order-state-machine.ts:46) 오프라인 주문에도 걸린다. 단체 10명
       --    주문에서 1명만 환불하면 주문이 그 상태가 되는데, 여기서 빼면 **취소되지 않은
       --    나머지 9명이 통째로 사라진다.** 개별 구분은 아래 참석자 조건이 한다.
       --    같은 판단의 선례: group-bookings/[bookingId]/route.ts:121.
       --
       -- ⚠️ pending 을 넣지 않는 것도 의도다. 승인제 RSVP 는 결제확정 없이 참석자만
       --    pending 으로 키잉된다(public/rsvp/route.ts:127) — 아직 발권되지 않은
       --    사람이므로 발권 명단에 없는 게 맞다. 승인되면 completed 로 올라와 뜬다.
       AND o.status IN ('completed', 'partially_refunded')
       -- 주문이 살아 있어도 참석자는 개별 회수(초대권 회수 등)될 수 있다.
       AND a.status <> 'cancelled'
     ORDER BY a.created_at DESC`,
    [eventId, session.accountId],
  );
  return successResponse(rows);
});

export const POST = withAuth<Params>(async (request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "ticket_issuance");
  if (featureBlock) return featureBlock;
  const body = (await request.json()) as {
    name: string; email?: string; phone?: string; productId: string; memo?: string;
    // F1 daypass 지정일(YYYY-MM-DD). daypass 이벤트에서만 유효.
    admissionDay?: string;
  };
  let idempotencyToken: string;
  try {
    idempotencyToken = requireIdempotencyKey(request);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Idempotency-Key 헤더가 필요합니다", 400);
  }

  if (!body.name || !body.productId) {
    return errorResponse("이름과 상품은 필수입니다", 400);
  }

  // F1: admission_day 형식 검증(전달된 경우). v2 가 daypass 이벤트에 한해 티켓에 부여.
  if (body.admissionDay && !/^\d{4}-\d{2}-\d{2}$/.test(body.admissionDay)) {
    return errorResponse("입장 지정일 형식이 올바르지 않습니다", 400);
  }

  const pool = getPool();

  // 감사 P1-8: 수동발권을 v2 우회 직접 INSERT(orders/order_items/attendees) 에서 표준
  // createOrder(v2 SSOT) 경유로 통일한다. 무료 발권이라 판매상품과 별개인 숨김 0원 "초대권"
  // tier 로 0원 주문을 만든다(v2 는 유료 tier 에 0원 주문을 AMOUNT_MISMATCH 로 거부). 원래
  // 선택한 상품 id 는 answers 메타로 기록해 추적 가능하게 둔다.
  let comp: { productId: string } | null;
  try {
    comp = await ensureCompProduct(pool, eventId, session.accountId);
  } catch {
    return errorResponse("수동발권에 실패했습니다", 500);
  }
  if (!comp) {
    return errorResponse("이벤트가 커머스(v2)에 아직 연결되지 않았습니다. 잠시 후 다시 시도해주세요.", 503);
  }

  // 이메일 미입력 comp(현장 초대 등)는 v2 게스트 resolve 를 위해 유니크 플레이스홀더를 만든다.
  const email = body.email?.trim()
    ? body.email.trim().toLowerCase()
    : `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@no-reply.pickket.kr`;

  try {
    const result = await createOrder({
      accountId: session.accountId,
      eventId,
      buyerName: body.name,
      buyerEmail: email,
      buyerPhone: body.phone,
      items: [{ productId: comp.productId, quantity: 1, admissionDay: body.admissionDay ?? null }],
      paymentMethod: "offline",
      status: "completed",
      paymentStatus: "paid",
      totalAmountOverride: 0,
      paidAmount: 0,
      source: "direct",
      memo: body.memo ?? "수동발권",
      answers: {
        _manualIssue: "true",
        _intendedProductId: body.productId,
        ...(body.memo ? { memo: body.memo } : {}),
      },
      idempotencyToken,
    });

    // 주문 메모 표시값 보존(GET 목록이 o.memo 를 읽음).
    await pool.query(`UPDATE orders SET memo = $2, updated_at = NOW() WHERE id = $1`, [
      result.id,
      body.memo ?? "수동발권",
    ]);
    // T2-ORD: 발급 결과를 go attendees 재조회 대신 createOrder 반환값에서 읽는다.
    // ticketNumbers 는 v2 ticket id 에서 결정적으로 파생되어 앵커 기록값과 동일하다.
    const ticketNumber = result.ticketNumbers[0] ?? null;
    // F4: raffle_enabled 이벤트면 발권 시 경품번호가 부여됨(F5 초대권 표시가 소비).
    const raffleNumber = result.ticketIds[0]
      ? (result.raffleNumbers[result.ticketIds[0]] ?? null)
      : null;

    await logAudit({
      userId: session.id,
      accountId: session.accountId,
      action: "create",
      tableName: "attendees",
      recordId: result.id,
      changes: { type: "manual_issuance", name: body.name, ticketNumber, intendedProductId: body.productId },
      ipAddress: auditClientIp(request.headers),
    });

    return successResponse({
      orderNumber: result.orderNumber,
      ticketNumber,
      raffleNumber,
      orderId: result.id,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse("수동발권을 잠시 후 다시 시도해주세요.", 503);
    }
    const message = err instanceof Error ? err.message : "발권 실패";
    return errorResponse(`수동발권 실패: ${message}`, 400);
  }
});

import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { projectToGoAttendeeStatus } from "@/lib/domain-model";
import { createOrder } from "@/lib/server/orders";
import { deriveTicketNumber } from "@/lib/ticket/ticket-number";
import { getTiersByEvent, listAttendees, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, resolveOwnedV2EventId } from "@/lib/v2/event-access";
import { requireIdempotencyKey } from "@/lib/server/idempotency";

/**
 * 🔴 상태 필터는 **go 어휘 그대로** v2 에 넘긴다 (2026-08-01 prod 실측 결함 수정).
 *
 * 예전에는 여기서 go→v2 로 한 번 번역해서 넘겼다(`confirmed→active`, `cancelled→cancelled`).
 * 그런데 표시 투영은 **N:1** 이다 — `cancelled` 와 `expired` 가 둘 다 「취소됨」으로 보인다.
 * 번역표만 1:1 이라, KLPGA prod 에서 **화면엔 「취소됨」 3건인데 취소 필터는 0건**이었다.
 * 같은 필터를 부르는 「취소됨」 통계 카드도 함께 0 이었다.
 *
 * 번역을 양쪽에 두면 언젠가 어긋난다. ⟹ 어휘 해석을 **v2 한 곳**으로 모은다.
 * v2 는 투영표에서 역상을 계산하고, `checked_in_at` 우선순위(표시와 동일)까지 적용한다.
 *
 * ⚠️ 배포 순서 **v2 backend → go**. 옛 v2 는 go 어휘 `confirmed` 를 400 으로 거절한다.
 *    (`pending`·`cancelled` 는 어휘가 겹쳐 옛 v2 에서도 통과한다 — `confirmed` 만 신규다.)
 */
const GO_ATTENDEE_STATUSES = new Set(["pending", "confirmed", "cancelled", "checked_in"]);

type Params = { eventId: string };

const attendeeSchema = z.object({
  name: z.string().min(2, "이름은 2자 이상이어야 합니다"),
  email: z.email("올바른 이메일 형식을 입력해주세요").optional().or(z.literal("")),
  phone: z.string().optional(),
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(100).optional(),
});

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const GET = withRole<Params>("organizer", async (request, { session, params }) => {
  // 빅뱅 flip D — go DB JOIN → v2 참석자(=ticket) live read(ticket SoT=v2).
  const { searchParams } = new URL(request.url);
  const page = parsePositiveInt(searchParams.get("page"), 1);
  const limit = Math.min(parsePositiveInt(searchParams.get("limit"), 20), 100);
  const offset = (page - 1) * limit;
  // status/q 필터는 v2 §14 read 가 서버측 지원 — 필터링을 v2 에 위임(페이지네이션 total 정확).
  // 체크인 여부는 checkedInAt(ticket.checked_in_at, v2 SoT)으로 파생 — v2 가 같은 규칙으로 거른다.
  const goStatus = searchParams.get("status")?.trim() || undefined;
  // 아는 어휘만 전달한다. 모르는 값을 그대로 넘기면 v2 가 400 을 주고 화면이 통째로 깨진다.
  const status = goStatus && GO_ATTENDEE_STATUSES.has(goStatus) ? goStatus : undefined;
  const q = searchParams.get("q")?.trim() || undefined;

  // W4-ORD: go attendees 앵커 read 폐기. 티켓번호 정본은 v2(`tickets.ticket_number`)이고,
  //   값이 없어도 ticket_id 에서 **같은 결정적 공식**으로 파생 가능하다(deriveTicketNumber).
  //   go pool 접근이 이 라우트에서 완전히 사라졌다.

  // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
  // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found → 빈 목록).
  let v2EventId: string | null;
  try {
    v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
  } catch (err: unknown) {
    // 아래 try/catch 밖이라 여기서 명시 처리 — v2 장애를 "참석자 0명"으로 위장하지 않는다.
    if (err instanceof EventAccessError) {
      return errorResponse("참석자 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!v2EventId) {
    // 없거나 내 계정 소유가 아님 → 목록류 빈 폴백 유지.
    return listResponse([], 0, page, limit);
  }

  try {
    // 모든 상태 필터를 v2 가 서버측에서 처리한다 — 옛 checked_in 전용 우회(10000건 전량 로드 후
    // 클라이언트 필터링)는 폐기했다. 전량 로드는 대회 당일 참석자가 늘수록 느려지고,
    // 무엇보다 **표시 규칙이 두 곳에 갈라져 있던 원인**이었다.
    const r = await listAttendees(v2EventId, { status, q, limit, offset });

    const allRows = r.attendees.map((a) => ({
      id: a.ticket_id,
      orderId: a.order_id,
      // W4-ORD: v2 ticket_number 정본 → 미보유 시 ticket_id 에서 결정적 파생.
      //   go 앵커 JOIN(옛 경로)과 동일한 값이 나온다 — 두 공식이 같기 때문(ticket-number.ts 주석).
      //   UUID 원본으로 폴백하지 않는다: 티켓번호는 소비자 URL/QR 키라 형식이 갈리면 링크가 깨진다.
      ticketNumber: a.ticket_number ?? deriveTicketNumber(a.ticket_id),
      ownerUserId: a.owner_user_id,
      // v2 보강 read — order.buyer_* → owner User 폴백 실필드.
      name: a.name,
      email: a.email,
      phone: a.phone,
      // 체크인 우선 파생(checked_in_at), 그 외 v2 ticket status → go 참석자 상태 투영(active→confirmed 등).
      status: a.checked_in_at ? "checked_in" : projectToGoAttendeeStatus(a.status),
      checkedInAt: a.checked_in_at,
      seatId: a.seat_id,
      productName: a.product_name,
        // 🔴 현장 임시티켓 출력용 (2026-08-19). v2·타입에는 이미 있었는데 매핑에서만
        //    빠져 화면이 경품번호를 못 봤다. 추첨 당첨자 연락의 기준 번호다.
        raffleNumber: a.raffle_number,
    }));

    return listResponse(allRows, r.total, page, limit);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // v2 앵커가 이미 존재하는데 read가 실패한 것은 정상 빈 목록이 아니라 장애다.
      // 빈 목록 폴백은 위의 앵커 미준비 분기에서만 허용한다(0명 오인 방지).
      return errorResponse("참석자 데이터를 불러오지 못했습니다", 502);
    }
    return errorResponse(err instanceof Error ? err.message : ERR.SERVER, 500);
  }
});

/**
 * 참석자 수동추가 — 감사 P0-5.
 *
 * 기존엔 go DB order_items/attendees 를 직접 INSERT 했으나(v2 미연결 → v2_ticket_id=NULL →
 * 체크인 영구 409 고아 + v2 SoT 라인에 위조행). 표준 createOrder(v2 write-through) 경유로 교체한다.
 * createOrder 가 v2 원자주문 → ticket_id 발급 → go attendees 를 v2_ticket_id 키잉으로 자동 INSERT
 * 하므로 체크인 즉시 가능하다. 오프라인 즉시확정(paid) 주문으로 만든다.
 *
 * 멱등: createOrder 의 external_order_id 는 매 호출 신규(UUID)라 중복 클릭 시 별도 주문이 생기지만,
 * "수동추가"는 사용자 의도가 매번 신규 참석자 등록이므로 이는 정상 동작이다(재승인형 중복주문과 무관).
 */
export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const idempotencyToken = requireIdempotencyKey(request);
    const body = attendeeSchema.parse(await request.json());
    const quantity = body.quantity ?? 1;

    // 레벨2 read-flip: 단가 정본 = v2 tier.base_price (go products.price 직접 read 폐기).
    //   상품 존재 확인도 v2 티어(external_ref=productId) 해석 여부로 판정. 미앵커 이벤트는 SoT 미연결로 거부.
    //   createOrder 가 v2 SoT 로 최종 재계산하므로 override 는 화면 표기용 총액 힌트일 뿐이나,
    //   go price 대신 v2 base_price 를 기준으로 삼아 표기 총액이 실결제(v2)와 어긋나지 않게 한다.
    // 레벨2 컷오버 T2-EVT — go events 앵커 조회 폐기(go event id == v2 event id).
    // 테넌트 경계는 이제 v2 가 강제한다(organizer_ref 불일치 → not found).
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      // 없거나 내 계정 소유가 아님 → 기존 409 동작 보존.
      return errorResponse("이벤트가 아직 커머스(v2)에 연결되지 않았습니다", 409);
    }
    let unitPrice: number;
    try {
      const tierMap = await getTiersByEvent(v2EventId);
      const tier = tierMap.get(body.productId);
      if (!tier) {
        return errorResponse(ERR.NOT_FOUND, 404);
      }
      unitPrice = Number(tier.base_price);
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        return errorResponse(`상품 정보를 불러오지 못했습니다 (v2: ${err.message})`, 502);
      }
      throw err;
    }
    const totalAmount = unitPrice * quantity;

    let order: Awaited<ReturnType<typeof createOrder>>;
    try {
      order = await createOrder({
        accountId: session.accountId,
        eventId: params.eventId,
        buyerName: body.name,
        buyerEmail: (body.email || "").trim().toLowerCase() || `noemail+${Date.now()}@pickket.local`,
        buyerPhone: body.phone || undefined,
        items: [{ productId: body.productId, quantity }],
        paymentMethod: "offline",
        status: "completed",
        paymentStatus: "paid",
        totalAmountOverride: totalAmount,
        paidAmount: totalAmount,
        source: "direct",
        answers: { _manualAdd: "true" },
        idempotencyToken,
      });
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        return errorResponse(`커머스 동기화에 실패했습니다: ${err.message}`, 502);
      }
      return errorResponse(err instanceof Error ? err.message : ERR.SERVER, 400);
    }

    // W4-ORD: go attendees 재조회 폐기. createOrder 가 이미 v2 발권 결과(ticketIds/ticketNumbers)를
    //   돌려주므로 같은 값을 재조회할 이유가 없다. 반환 `id` 는 **v2 ticket_id** 로 통일한다 —
    //   목록 GET 이 이미 `id: a.ticket_id` 를 반환하고 상세/체크인도 ticket_id 로 조회하므로
    //   여기서 go-native attendees.id 를 돌려주면 식별자 체계가 둘로 갈린다.
    const firstTicketId = order.ticketIds[0];
    if (!firstTicketId) {
      // 티켓이 발급되지 않음(이론상) — 주문은 생성됐으나 발권 0.
      return errorResponse("참석자 발권에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }

    return successResponse(
      { id: firstTicketId, ticketNumber: order.ticketNumbers[0] ?? deriveTicketNumber(firstTicketId) },
      201,
    );
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    // v2 장애로 소유 확인이 불가한 경우 — 500(서버 오류)이 아니라 재시도 가능 신호(503).
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

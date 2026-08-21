import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
// W5-ATTENDEE: 이 라우트의 go DB 참조가 0 이 됐다. 남아 있던 go-local 원장 2개도 v2 정본으로:
//   · `event_questions` → v2 `event_questions`(문항 정의). 응답 라벨 해석이라 **보관 문항 포함**.
//   · `check_in_logs`   → v2 `check_in_logs`(티켓 단위 이력).
import { ERR } from "@/lib/errors";
import { projectToGoAttendeeStatus } from "@/lib/domain-model";
import { deriveTicketNumber } from "@/lib/ticket/ticket-number";
import { resolveOwnedTicket, TicketAccessError } from "@/lib/v2/ticket-access";
import {
  listCheckInLogs,
  listEventQuestions,
  V2CommerceError,
  type TicketDetail,
} from "@/lib/v2/commerce-client";

type Params = { eventId: string; attendeeId: string };

// 참석자 상태(status) 전이는 v2 티켓 SoT 다. go attendees.status 는 발송 세그먼트용 투영 캐시로
// 강등됐으므로, 여기서 go 만 직접 UPDATE 하면 v2 티켓(ACTIVE/USED)·좌석·환불과 어긋나는
// split-brain 이 된다. 상태 전이는 v2 를 거치는 전용 경로로 위임한다:
//   - 확정(pending→confirmed)      → 주문 결제확정(orders 결제/confirm-payment)
//   - 체크인(confirmed→checked_in) → 체크인 라우트(POST /events/{id}/check-in, v2 checkInTicket)
//   - 취소(→cancelled)             → 주문 항목취소(POST /events/{id}/orders/{orderId}/modify, v2 라인환불)
//
// 연락처(name/email/phone)의 SoT 도 v2 다: v2 참석자 목록·상세·소비자·알림은 전부
// Order.buyer_*(→ owner User 폴백)에서 연락처를 읽는다(internal_commerce_read.py event_attendees/get_ticket).
// v2 에는 기존 주문의 buyer 연락처를 수정하는 write 경로가 없으므로(주문 생성 시에만 설정),
// go-local 연락처 편집을 차단(409)하고 "주문 정보에서 수정"으로 안내한다.
const attendeeSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.email().optional().or(z.literal("")),
  phone: z.string().optional(),
  // status 는 수용하되(호환) 아래에서 명시적으로 거부한다 — go 직접전이 금지.
  status: z.enum(["pending", "confirmed", "cancelled", "checked_in"]).optional(),
});

// W4-ORD: attendeeId = **v2 ticket_id**. 목록 GET(`id: a.ticket_id`)·수동추가 POST 가 모두
// ticket_id 를 반환하므로 식별자 체계가 하나다(옛 go-native attendees.id 겸용 조회 폐기).
const uuidParam = z.string().uuid();

/** 소유 판정 실패(v2 장애)를 503 으로 — "참석자 없음"(404)으로 위장하지 않는다. */
const UNAVAILABLE = "참석자 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  if (!uuidParam.safeParse(params.attendeeId).success) {
    return errorResponse(ERR.NOT_FOUND, 404);
  }

  // 상태·좌석·연락처·상품명·설문응답·티켓번호·주문번호 전부 v2 단건 티켓(SoT)에서 온다.
  // 소유 경계(event_id + go_account_id)도 v2 응답으로 강제 — go 앵커 WHERE 절 대체.
  let ticket: TicketDetail | null;
  try {
    ticket = await resolveOwnedTicket(params.attendeeId, params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof TicketAccessError) return errorResponse(UNAVAILABLE, 503);
    return errorResponse(ERR.SERVER, 500);
  }
  if (!ticket) return errorResponse(ERR.NOT_FOUND, 404);

  // 🔴 include_archived: 주최자가 나중에 지운 문항의 응답도 라벨과 함께 보여야 한다.
  //    (go 시절엔 문항을 지우면 이미 수집된 답변이 화면에서 통째로 사라졌다 — 무성 손실.)
  // 🔴 fail-closed: v2 실패를 "설문응답 없음 / 체크인 이력 없음"으로 강등하지 않는다.
  let questionRows: Array<{ id: string; label: string }>;
  let logRows: Array<{
    id: string;
    method: string;
    note: string | null;
    listName: string | null;
    createdAt: string | null;
  }>;
  try {
    const [questionsResult, logsResult] = await Promise.all([
      listEventQuestions(params.eventId, {
        accountId: session.accountId,
        includeArchived: true,
      }),
      listCheckInLogs(params.eventId, session.accountId, {
        ticketId: ticket.ticket_id,
        limit: 200,
      }),
    ]);
    questionRows = questionsResult.questions.map((q) => ({ id: q.id, label: q.label }));
    logRows = logsResult.logs.map((log) => ({
      id: log.id,
      method: log.method,
      note: log.note,
      listName: log.list_name,
      createdAt: log.created_at,
    }));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) return errorResponse(UNAVAILABLE, 503);
    throw err;
  }

  const rawAnswers = ticket.answers;
  const parsedAnswers =
    rawAnswers && typeof rawAnswers === "object" ? (rawAnswers as Record<string, string | string[]>) : {};
  const questionAnswers = questionRows
    .map((question) => {
      const answer = parsedAnswers[String(question.id)];
      if (!answer) {
        return null;
      }

      return {
        id: String(question.id),
        questionLabel: String(question.label),
        answer: Array.isArray(answer) ? answer.join(", ") : String(answer),
      };
    })
    .filter((item): item is { id: string; questionLabel: string; answer: string } => item !== null);

  return successResponse({
    // 식별자 = v2 ticket_id(목록·체크인과 동일 키).
    id: ticket.ticket_id,
    ticketNumber: ticket.ticket_number ?? deriveTicketNumber(ticket.ticket_id),
    name: ticket.order.buyer?.name ?? null,
    email: ticket.order.buyer?.email ?? null,
    phone: ticket.order.buyer?.phone ?? null,
    // 체크인 우선 파생(checked_in_at) → 그 외 v2 ticket status 를 go 참석자 상태로 투영(active→confirmed 등).
    status: ticket.checked_in_at ? "checked_in" : projectToGoAttendeeStatus(ticket.status),
    checkedInAt: ticket.checked_in_at,
    seatId: ticket.seat_id,
    // W4-ORD: 발급 시각 = v2 `issued_at`(구 go attendees.created_at).
    createdAt: ticket.issued_at ?? null,
    // 주문 식별자는 go 주문 id 원본(external_ref)을 우선한다 — 주문 상세 링크가 go 라우트라서.
    orderId: ticket.order.external_ref ?? ticket.order.id,
    orderNumber: ticket.order.order_number,
    productName: ticket.product_name,
    checkInLogs: logRows,
    questionAnswers,
  });
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    if (!uuidParam.safeParse(params.attendeeId).success) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }
    const body = attendeeSchema.parse(await request.json());

    // 존재·소유 확인(v2). 비소유/미존재는 404 로 종결해 안내 문구가 새지 않게 한다.
    let ticket: TicketDetail | null;
    try {
      ticket = await resolveOwnedTicket(params.attendeeId, params.eventId, session.accountId);
    } catch (err: unknown) {
      if (err instanceof TicketAccessError) return errorResponse(UNAVAILABLE, 503);
      throw err;
    }
    if (!ticket) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    // 상태 전이는 v2 티켓 SoT 전용 경로로만 허용 — go 직접전이 금지(split-brain 차단).
    if (body.status !== undefined) {
      return errorResponse(
        "참석자 상태는 이 화면에서 직접 변경할 수 없습니다. 체크인(체크인 화면) 또는 취소(주문 항목취소)를 이용해주세요.",
        409,
      );
    }

    // 연락처(name/email/phone) SoT = v2(Order.buyer_*). v2 에 기존 주문의 buyer 연락처를
    // 수정하는 write 경로가 없으므로(주문 생성 시에만 설정) 편집을 차단한다.
    if (body.name !== undefined || body.email !== undefined || body.phone !== undefined) {
      return errorResponse(
        "참석자 연락처는 이 화면에서 직접 변경할 수 없습니다. 주문 정보(구매자 연락처)에서 수정해주세요.",
        409,
      );
    }

    // 수정할 필드가 없음(상태·연락처 모두 미포함) — no-op 성공.
    return successResponse({ id: ticket.ticket_id });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

/**
 * 참석자 취소(=티켓 취소)는 v2 라인 환불(좌석 release + 환불 원장)을 원자로 수행하는
 * 주문 항목취소 경로가 정본이다: POST /events/{eventId}/orders/{orderId}/modify.
 * 여기서 참석자만 'cancelled' 로 바꾸면 v2 티켓은 ACTIVE·좌석 미release·미환불로 남아
 * split-brain(초과판매·미정산)이 된다. 따라서 go-only 취소를 차단하고 정본 경로로 안내한다.
 *
 * 🔴 v2 장애 시 **503 으로 끊는다**. 조회 실패를 "없음 → 이미 처리됨 → 성공"으로 흡수하면
 *    장애가 성공으로 위장된다(실결함 패턴).
 */
export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  if (!uuidParam.safeParse(params.attendeeId).success) {
    return errorResponse(ERR.NOT_FOUND, 404);
  }

  let ticket: TicketDetail | null;
  try {
    ticket = await resolveOwnedTicket(params.attendeeId, params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof TicketAccessError) return errorResponse(UNAVAILABLE, 503);
    return errorResponse(ERR.SERVER, 500);
  }
  if (!ticket) {
    return errorResponse(ERR.NOT_FOUND, 404);
  }

  return errorResponse(
    "참석자 취소는 주문 항목취소(환불) 화면에서 진행해주세요. 좌석 반환과 환불이 함께 처리됩니다.",
    409,
  );
});

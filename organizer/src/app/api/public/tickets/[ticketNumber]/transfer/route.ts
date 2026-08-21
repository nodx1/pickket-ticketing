import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { getPool } from "@/lib/db/pool";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { ERR } from "@/lib/errors";
import { invitationTokenGrantsAccess } from "@/lib/invitation-token";
import { logger } from "@/lib/logger";
import {
  V2CommerceError,
  getInvitationByTicketNumber,
  getTicketByNumber,
  resendInvitationV2,
  organizerIdRef,
  transferInvitationV2,
} from "@/lib/v2/commerce-client";

/**
 * 초대권 양도 — 손님이 받는 분 정보를 넣으면 **우리 서버가** 새 링크를 발송한다.
 *
 * ## 왜 이 경로가 필요한가 (2026-08-03 대표 지시)
 *
 * 지금 "선물하기" 는 `navigator.share()`/클립보드로 **링크만** 넘긴다.
 * 🔴 링크를 3명에게 보내면 3명이 같은 티켓을 보고, 현장에서 먼저 온 1명만 들어간다.
 * 소유자는 안 바뀌고 받은 사람 화면엔 **원래 사람 이름**이 뜬다.
 * VIP·스폰서 초대권은 "대신 받아 나눠주기" 가 일상이라 그게 그대로 사고가 된다.
 *
 * 링크가 손님 손이 아니라 **우리를 거치게** 하면:
 *   · 누가 가졌는지 원장에 남는다
 *   · 옛 링크를 확실히 죽인다(`token_version++`)
 *   · 받는 사람이 번호 소유로 증명된다(그 번호로 알림톡을 받는다)
 *
 * ## 🔴 인증을 넣지 않는다
 *
 * 이 시스템의 소유 증명은 **링크 소지**다 — 게이트가 QR 만 본다.
 * 보내는 사람은 유효한 딥링크 토큰으로 이 API 를 부른다는 것으로 증명되고,
 * 받는 사람은 그 번호로 알림톡을 받는다는 것으로 증명된다.
 * SMS 2단계를 넣으면 VIP 100장 배포가 100번 인증이 된다.
 */

const schema = z.object({
  /** 딥링크 토큰(`?t=`) — 이 티켓의 현재 소지자임을 증명한다. */
  token: z.string().min(10).max(2048),
  toName: z.string().trim().min(1, "받는 분 성함을 입력해주세요").max(50),
  toPhone: z.string().trim().min(9, "휴대폰 번호를 확인해주세요").max(20),
});

/** 숫자만 남긴다 — v2 `phone_normalized` 와 같은 규칙. */
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

function formatPhone(digits: string): string {
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

async function transferHandler(
  request: Request,
  { params }: { params: Promise<{ ticketNumber: string }> },
) {
  const { ticketNumber } = await params;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  const toPhoneNormalized = normalizePhone(body.toPhone);
  if (!/^01\d{8,9}$/.test(toPhoneNormalized)) {
    return errorResponse("휴대폰 번호 형식을 확인해주세요 (예: 010-1234-5678)", 400);
  }

  // ── 원장 조회 ────────────────────────────────────────────────────────────
  let invitation: Awaited<ReturnType<typeof getInvitationByTicketNumber>>["invitation"];
  let ticket: Awaited<ReturnType<typeof getTicketByNumber>>;
  try {
    [{ invitation }, ticket] = await Promise.all([
      getInvitationByTicketNumber(ticketNumber),
      getTicketByNumber(ticketNumber),
    ]);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError && err.status === 404) {
      return errorResponse("초대권을 찾을 수 없습니다", 404);
    }
    logger.error("[transfer] 원장 조회 실패", {
      ticketNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("잠시 후 다시 시도해주세요", 503);
  }

  if (!invitation) {
    // 유료 티켓은 이 경로 대상이 아니다 — 존재를 알리지 않는다.
    return errorResponse("초대권을 찾을 수 없습니다", 404);
  }

  // 🔴 **여기가 인가다.** 유효한 딥링크 토큰을 가진 사람만 양도할 수 있다.
  //    토큰은 (a)서명·만료 (b)티켓번호 일치 (c)원장 token_version 일치 를 모두 만족해야 한다.
  //    양도가 끝나면 token_version 이 올라가 이 토큰은 즉시 죽는다 — 재사용 불가.
  if (
    !invitationTokenGrantsAccess({
      token: body.token,
      ticketNumber,
      currentVersion: invitation.token_version,
    })
  ) {
    return errorResponse("초대권 링크가 만료되었거나 유효하지 않습니다", 403);
  }

  const organizerId = ticket.event?.organizer_id;
  if (!organizerId) {
    logger.error("[transfer] 이벤트에 organizer_id 가 없다", { ticketNumber });
    return errorResponse("잠시 후 다시 시도해주세요", 503);
  }

  // ── 양도 ────────────────────────────────────────────────────────────────
  let transferred: Awaited<ReturnType<typeof transferInvitationV2>>;
  try {
    transferred = await transferInvitationV2(
      invitation.id,
      organizerIdRef(organizerId),
      {
        name: body.toName,
        phoneNormalized: toPhoneNormalized,
        phoneDisplay: formatPhone(toPhoneNormalized),
      },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // v2 가 사유를 그대로 준다 — 손님에게 보여줄 수 있는 문구다.
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      return errorResponse(err.message, status);
    }
    logger.error("[transfer] v2 양도 실패", {
      ticketNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("양도에 실패했습니다. 잠시 후 다시 시도해주세요", 503);
  }

  // ── go 참석자 명단 투영 ──────────────────────────────────────────────────
  // 🔴 이게 없으면 **현장 체크인 명단이 옛 소유자를 가리킨다.**
  //    2026-08-03 첫 실사용에서 실제로 그랬다 — v2 원장은 서낙원으로 바뀌었는데
  //    go attendees 는 김상윤 그대로였다. 계획서에 "부수효과로 전파" 라고 적어놓고
  //    **호출 자체를 안 만들었다.** 그래서 로그에 실패 흔적도 없었다(시도를 안 했으니).
  //
  // ⚠️ best-effort 다 — 양도는 v2 에서 이미 커밋됐다. 이 투영이 실패해도 되돌리지 않는다.
  //    되돌리면 "티켓은 넘어갔는데 양도 실패" 로 보인다. 대신 **조용히 넘기지 않는다.**
  // ⚠️ `checked_in` 은 건드리지 않는다 — 이미 입장한 사람의 이력을 지우면 재입장이 열린다.
  //    (애초에 v2 가 입장한 초대권의 양도를 409 로 막는다. 여기는 이중 방어다.)
  try {
    const res = await getPool().query(
      `UPDATE attendees
          SET name = $2, phone = $3, updated_at = NOW()
        WHERE ticket_number = $1 AND status <> 'checked_in'`,
      [ticketNumber, transferred.invitation.recipient_name, toPhoneNormalized],
    );
    if ((res.rowCount ?? 0) === 0) {
      logger.warn("[transfer] 참석자 명단 투영 0건 — 현장 명단이 옛 소유자를 가리킬 수 있다", {
        ticketNumber,
        invitationId: invitation.id,
      });
    }
  } catch (err: unknown) {
    logger.error("[transfer] 🔴 참석자 명단 투영 실패 — 현장 명단이 옛 소유자를 가리킨다", {
      ticketNumber,
      invitationId: invitation.id,
      to: toPhoneNormalized,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 새 링크 발송 ─────────────────────────────────────────────────────────
  // 🔴 여기가 이 라우트의 가장 위험한 자리다. 양도는 이미 커밋됐고 **옛 링크는 죽었다**.
  //    발송까지 실패하면 초대권이 허공에 뜬다 — 보낸 사람도 받는 사람도 못 연다.
  //    그래서 실패를 삼키지 않고 **명시적으로 알린다**. 원장에는 issued 로 남아 있어
  //    주최자가 대시보드에서 재발송할 수 있다(복구 경로가 존재한다).
  let queued = false;
  try {
    const res = await resendInvitationV2(invitation.id, organizerIdRef(organizerId));
    queued = res.requeued;
  } catch (err: unknown) {
    logger.error("[transfer] 🔴 양도는 됐는데 발송 큐 적재 실패 — 주최자 재발송 필요", {
      ticketNumber,
      invitationId: invitation.id,
      toPhone: toPhoneNormalized,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!queued) {
    return successResponse({
      transferred: true,
      queued: false,
      recipientName: transferred.invitation.recipient_name,
      message:
        "양도는 완료됐지만 알림톡 발송이 지연되고 있습니다. " +
        "받는 분께 도착하지 않으면 주최자에게 재발송을 요청해주세요.",
    });
  }

  logger.info("[transfer] 초대권 양도 완료", {
    ticketNumber,
    invitationId: invitation.id,
    from: transferred.from.phone_normalized,
    to: toPhoneNormalized,
  });

  return successResponse({
    transferred: true,
    queued: true,
    recipientName: transferred.invitation.recipient_name,
    message: `${transferred.invitation.recipient_name}님께 초대권을 보냈습니다.`,
  });
}

// 🔴 공개 경로 + 되돌릴 수 없는 동작이다. 오타·연타로 초대권이 모르는 사람에게 가는 것을
//    막아야 하므로 레이트리밋을 짧게 건다(환불 신청과 같은 수준).
export const POST = withRateLimit({
  max: 5,
  windowMs: 60_000,
  keyPrefix: "public:invitation-transfer",
})(transferHandler);

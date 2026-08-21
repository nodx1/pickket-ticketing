import { z } from "zod";
/**
 * 수신함 단건 조회/수정/답장 — 원장은 v2 소유(레벨2 컷오버 W5-MSG). inbound_emails go SQL 0.
 *
 * 🔴 `accounts` 조회(회신처 contact_email)는 **다른 트랙 소유 테이블**이라 그대로 둔다.
 */
// W5-MSG 잔여 go DB: accounts(회신처 조회) — 이 트랙 소유 아님(계정 트랙).
import { getPool } from "@/lib/db/pool";
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { sendEmail } from "@/lib/notification/email";
import { EventAccessError, eventAccessStatus, getOwnedEvent } from "@/lib/v2/event-access";
import {
  getInboundEmail,
  ledgerErrorStatus,
  patchInboundEmail,
  recordInboundReply,
  V2MessagingLedgerError,
} from "@/lib/v2/messaging-ledger-client";
import { logger } from "@/lib/logger";

/**
 * 이벤트 소유 게이트 (레벨2 컷오버 W4-EVT).
 *
 * 🔴 v2 장애를 404("이벤트를 찾을 수 없습니다")로 뭉개지 않는다 — 특히 PATCH/POST 는
 *    "없어서 못 했다"와 "확인 불가"가 전혀 다른 의미다. 확인 불가는 503 으로 끊는다.
 *
 * @returns 차단 시 Response, 통과 시 null
 */
async function guardEventOwnership(eventId: string, accountId: string): Promise<Response | null> {
  try {
    const owned = await getOwnedEvent(eventId, accountId);
    return owned ? null : errorResponse("이벤트를 찾을 수 없습니다", 404);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(
        "이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        eventAccessStatus(err),
      );
    }
    throw err;
  }
}

/** 원장 조회/기록 실패를 500 으로 뭉개지 않는다(fail-closed: 404 vs 503 구분). */
function ledgerFailure(err: unknown, fallback: string): Response {
  if (err instanceof V2MessagingLedgerError) {
    return errorResponse(err.message, ledgerErrorStatus(err));
  }
  return errorResponse(err instanceof Error ? err.message : fallback, 500);
}

/** HTML 특수문자 이스케이프 — 답장 텍스트를 HTML 본문에 안전하게 삽입(XSS 방지). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const GET = withAuth(async (_request, { session, params }) => {
  const { eventId, emailId } = params as { eventId: string; emailId: string };

  // 🔴 소유 게이트는 광범위 catch **밖**에서 — 안에 두면 v2 장애가 500 으로 뭉개진다.
  const blocked = await guardEventOwnership(eventId, session.accountId);
  if (blocked) return blocked;

  try {
    const email = await getInboundEmail(session.accountId, eventId, emailId);
    if (!email) return errorResponse("이메일을 찾을 수 없습니다", 404);
    return successResponse({
      id: email.id,
      fromEmail: email.from_email,
      fromName: email.from_name,
      subject: email.subject,
      bodyText: email.body_text,
      bodyHtml: email.body_html,
      status: email.status,
      aiDraft: email.ai_draft,
      assignedTo: email.assigned_to,
      createdAt: email.created_at,
      updatedAt: email.updated_at,
    });
  } catch (err: unknown) {
    return ledgerFailure(err, "이메일 조회에 실패했습니다");
  }
});

const updateSchema = z.object({
  status: z.enum(["new", "replied", "archived"]).optional(),
  assignedTo: z.string().uuid().optional().nullable(),
});

export const PATCH = withAuth(async (request, { session, params }) => {
  const { eventId, emailId } = params as { eventId: string; emailId: string };

  const blocked = await guardEventOwnership(eventId, session.accountId);
  if (blocked) return blocked;

  try {
    const body = updateSchema.parse(await request.json());
    const updated = await patchInboundEmail(session.accountId, eventId, emailId, {
      status: body.status,
      assignedTo: body.assignedTo,
    });
    if (!updated) return errorResponse("이메일을 찾을 수 없습니다", 404);
    return successResponse({ id: updated.id });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "요청이 올바르지 않습니다", 400);
    }
    return ledgerFailure(err, "이메일 수정에 실패했습니다");
  }
});

const replySchema = z.object({
  reply: z.string().trim().min(1, "답장 내용을 입력해주세요").max(5000, "답장은 5000자 이하로 입력해주세요"),
});

// 수신 이메일에 대한 답장 실발송.
// 발신 From = pickket.kr 인증 도메인(고정), Reply-To = 주최자 연락 이메일(릴레이).
// 릴레이 목적상 회신처(contact_email)가 없으면 발송하지 않는다.
export const POST = withAuth(async (request, { session, params }) => {
  const { eventId, emailId } = params as { eventId: string; emailId: string };

  // 이벤트 소유권 검증 (테넌트 경계) — 🔴 실발송 라우트라 게이트를 catch 밖에 두는 게 특히 중요하다.
  // v2 장애를 500 "답장 발송에 실패했습니다" 로 뭉개면 주최자가 무한 재시도한다.
  const blocked = await guardEventOwnership(eventId, session.accountId);
  if (blocked) return blocked;

  try {
    const { reply } = replySchema.parse(await request.json());

    // 수신 이메일 확인 (event 스코프) — v2 원장.
    const inbound = await getInboundEmail(session.accountId, eventId, emailId);
    if (!inbound) return errorResponse("이메일을 찾을 수 없습니다", 404);

    // 주최자 회신처 — 릴레이 도착지(Reply-To). 없으면 발송 불가. (accounts = 계정 트랙 소유)
    const pool = getPool();
    const { rows: accounts } = await pool.query<{ contact_email: string | null; name: string | null }>(
      `SELECT contact_email, name FROM accounts WHERE id = $1`,
      [session.accountId],
    );
    const contactEmail = accounts[0]?.contact_email?.trim() || null;
    const accountName = accounts[0]?.name?.trim() || "주최자";
    if (!contactEmail) {
      return errorResponse(
        "회신 이메일이 설정되지 않았습니다. 계정 설정에서 연락 이메일을 등록한 뒤 다시 시도해주세요.",
        400,
      );
    }

    // 답장 텍스트 → HTML (이스케이프 후 개행 변환) + 릴레이 안내 푸터
    const bodyHtml =
      `<div style="font-size:14px;line-height:1.6;color:#1A1D2E;">${escapeHtml(reply).replace(/\n/g, "<br>")}</div>` +
      `<hr style="margin:24px 0;border:none;border-top:1px solid #E5E7EB;">` +
      `<p style="font-size:12px;color:#6B7280;">— 본 메일에 회신하시면 주최자(${escapeHtml(accountName)} · ${escapeHtml(contactEmail)})에게 전달됩니다.</p>`;

    const subject = `Re: ${inbound.subject ?? "문의"}`;

    // 🔴 트랜잭션 경계: **외부호출(실발송) 후** 감사 기록. 순서를 뒤집으면 발송 실패한 답장이
    //    "답변 완료"로 남는다. 멱등키는 emailId 기반 안정 키 — 재시도가 2통을 보내지 않는다.
    const sendResult = await sendEmail({
      to: inbound.from_email,
      subject,
      bodyHtml,
      bodyText: reply,
      replyTo: contactEmail,
      idempotencyKey: `inbox-reply-${emailId}`,
    });

    // 발송 성공 후 감사 기록. 여기서 실패해도 **메일은 이미 나갔다** — 재발송을 유도하지
    // 않고 기록 실패만 알린다(같은 답장을 또 보내는 것이 더 나쁘다).
    try {
      await recordInboundReply(session.accountId, eventId, emailId, reply, session.accountId);
    } catch (err: unknown) {
      logger.error("답장 발송 성공 후 감사 기록 실패", {
        emailId,
        error: err instanceof Error ? err.message : "unknown",
      });
      return successResponse({
        sent: true,
        simulated: sendResult.simulated === true,
        auditRecorded: false,
      });
    }

    return successResponse({
      sent: true,
      simulated: sendResult.simulated === true,
      auditRecorded: true,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "요청이 올바르지 않습니다", 400);
    }
    return ledgerFailure(err, "답장 발송에 실패했습니다");
  }
});

/**
 * 조직자 문의 인박스 — 소비자 문의 조회(GET) + 상태/회신 갱신(PATCH).
 * 연락처는 PII 이므로 마스킹해 반환.
 */
import { z } from "zod";
import { withRole } from "@/lib/auth/permissions";
// ── 레벨2 컷오버 W5-SUPPORT: go `event_inquiries` → v2 `event_inquiries`(신설). ──
// v2 `contact_inquiries`/`cs_tickets` 는 전역·admin 스코프라 이벤트 스코프 문의함과 1:1 이
// 아니어서 재사용하지 않고 별도 테이블을 신설했다.
// 테넌트 경계(옛 `WHERE account_id = $1 AND event_id = $2`)는 v2 `events.organizer_id` 가
// 강제한다(organizer_ref 불일치 → 404).
// 🔴 잔여(범위 밖): `accounts` 조회(회신 Reply-To) — 계정 테이블 이관은 별도 트랙 소유.
import { getPool } from "@/lib/db/pool";
import {
  listEventInquiries,
  patchEventInquiry,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { listResponse, successResponse, errorResponse } from "@/lib/apiResponse";
import { logger, maskPII } from "@/lib/logger";
import { ERR } from "@/lib/errors";
import { sanitizeHtml } from "@/lib/sanitize";
import { sendEmail } from "@/lib/notification/email";

// 간단한 이메일 형식 판별 — 전화번호 등 비이메일 연락처는 이메일 통지 대상에서 제외.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Params = { eventId: string };

export const GET = withRole<Params>("organizer", async (request, { session, params }) => {
  const status = new URL(request.url).searchParams.get("status");
  try {
    const result = await listEventInquiries(params.eventId, session.accountId, {
      status: status ?? undefined,
    });
    // 연락처는 PII — 목록 표시용으로 마스킹(원문은 회신 발송 시에만 v2 PATCH 응답으로 받는다).
    const items = result.inquiries.map((r) => ({
      id: r.id,
      contact: r.contact ? maskPII(r.contact) : null,
      question: r.question,
      answer: r.answer,
      status: r.status,
      source: r.source,
      createdAt: r.created_at,
    }));
    return listResponse(items, items.length);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 🔴 빈 배열 폴백 금지 — "문의 없음"으로 오독되면 주최자가 고객을 방치한다.
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      if (err.status === 400) return errorResponse(ERR.INVALID_INPUT, 400);
      return errorResponse("문의를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});

const patchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["open", "answered", "archived"]).optional(),
  answer: z.string().max(2000).optional(),
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const b = patchSchema.parse(await request.json());
    const pool = getPool();
    // v2 갱신은 즉시 확정 — 아래 sendEmail 실패가 답변 저장을 되돌리면 안 되므로 별도 경계.
    // 응답으로 원문 contact/question/answer 를 받는다(원문 contact 는 로그에 남기지 않는다).
    let row: { contact: string | null; question: string; answer: string | null };
    try {
      const patched = await patchEventInquiry(params.eventId, b.id, {
        organizer_ref: session.accountId,
        status: b.status,
        answer: b.answer,
      });
      row = {
        contact: patched.inquiry.contact,
        question: patched.inquiry.question,
        answer: patched.inquiry.answer,
      };
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        // 미존재/미소유만 404. 🔴 v2 장애를 404("문의 없음")나 400("입력 오류")으로 뭉개면
        //    주최자가 존재하는 문의를 사라졌다고 오인하거나 무한 재입력하게 된다.
        if (err.status === 404) return errorResponse("문의를 찾을 수 없습니다", 404);
        if (err.status === 400) return errorResponse(ERR.INVALID_INPUT, 400);
        return errorResponse("문의를 저장하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      throw err;
    }

    // 이번 요청에서 답변이 새로 제공되고 비어있지 않을 때만 소비자 통지 시도.
    const providedAnswer = typeof b.answer === "string" ? b.answer.trim() : "";
    if (!providedAnswer) {
      return successResponse({ updated: true, notified: false, reason: "no_answer" });
    }

    const contact = row.contact ?? "";
    if (!EMAIL_RE.test(contact)) {
      // 전화번호 등 비이메일 연락처 — 문자/알림톡은 범위 밖이므로 통지 스킵.
      return successResponse({ updated: true, notified: false, reason: "non_email_contact" });
    }

    // 회신처(Reply-To)는 주최자 연락 이메일. 발신은 pickket.kr 인증 도메인 고정.
    const acct = await pool.query<{ contact_email: string | null; name: string }>(
      `SELECT contact_email, name FROM accounts WHERE id = $1`,
      [session.accountId],
    );
    const organizerEmail = acct.rows[0]?.contact_email ?? undefined;
    const organizerName = acct.rows[0]?.name ?? "주최자";

    const questionHtml = sanitizeHtml(row.question).replace(/\n/g, "<br>");
    const answerHtml = sanitizeHtml(providedAnswer).replace(/\n/g, "<br>");
    const bodyHtml = [
      `<p>보내주신 문의에 답변이 도착했습니다.</p>`,
      `<blockquote style="border-left:3px solid #ddd;margin:0;padding:0 0 0 12px;color:#555">${questionHtml}</blockquote>`,
      `<p>${answerHtml}</p>`,
      `<hr><p style="color:#888;font-size:12px">— 회신하시면 주최자(${sanitizeHtml(organizerName)})에게 전달됩니다.</p>`,
    ].join("");

    try {
      const result = await sendEmail({
        to: contact,
        subject: "문의 답변이 도착했습니다",
        bodyHtml,
        replyTo: organizerEmail,
        idempotencyKey: `inquiry-answer-${b.id}`,
      });
      // 원문 contact 는 로그에 남기지 않는다(마스킹).
      logger.info("문의 답변 통지 발송", { inquiryId: b.id, to: maskPII(contact), simulated: result.simulated });
      return successResponse({ updated: true, notified: true, simulated: result.simulated });
    } catch (sendErr: unknown) {
      // 발송 실패는 이미 커밋된 답변 저장을 롤백하지 않는다 — 200 유지, 통지 실패만 보고.
      logger.error("문의 답변 통지 발송 실패", {
        inquiryId: b.id,
        error: sendErr instanceof Error ? sendErr.message : "unknown",
      });
      return successResponse({ updated: true, notified: false, reason: "send_failed" });
    }
  } catch (err: unknown) {
    if (err instanceof z.ZodError) return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    return errorResponse(ERR.SERVER, 500);
  }
});

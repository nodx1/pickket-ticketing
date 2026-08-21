/**
 * 본인 테스트발송 — 작성 중인 메시지를 로그인한 담당자 본인에게 1건 발송한다.
 * 실제 발송 경로(dispatchOne)와 동일하게 나가되, 대상은 본인 연락처(또는 명시 to).
 * 개인화 {이름}/{name} 은 담당자 이름으로 치환. 트래킹 미주입(테스트).
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { dispatchOne } from "@/lib/notification/dispatch";
import { personalizeName } from "@/lib/notification/personalize";
import { deriveMessageType } from "@/lib/notification/message-purpose";
import type { Channel } from "@/lib/notification/compliance";
import { isOrganizerMessagingV2Enabled } from "@/lib/notification/v2-flag";
import { testSendOrganizerMessage, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, getOwnedEvent } from "@/lib/v2/event-access";
import { V2MessagingComplianceError } from "@/lib/v2/messaging-compliance-client";

type Params = { eventId: string };

const CHANNEL_MAP: Record<string, Channel> = { email: "email", sms: "sms", alimtalk: "kakao" };

// H-06: 임의 to 제거 — 테스트 발송은 로그인 담당자 본인 연락처로만. 스팸 릴레이 차단.
// §3-1: messageType 클라이언트 선택 제거 — 목적(purpose) 기반 서버 판정.
const schema = z.object({
  channel: z.enum(["email", "sms", "alimtalk"]),
  title: z.string().min(1),
  body: z.string().min(1),
  purpose: z.enum(["checkin", "notice", "reminder", "promotion", "sale"]).optional(),
  templateCode: z.string().optional(),
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const b = schema.parse(await request.json());
    const channel = CHANNEL_MAP[b.channel];

    // H-06: 이벤트 소유검증 — 타 계정 이벤트 컨텍스트로의 발송 방지.
    // W3-MSG: go `events` 조회 → v2 소유검증(테넌트 경계는 v2 organizer_ref 가 강제).
    if ((await getOwnedEvent(params.eventId, session.accountId)) === null) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    // H-06: 계정당 일일 20건 quota — NCP 계정 남용/과금 방어. Redis 장애 시 fail-closed.
    const quota = await checkRateLimit(`test-send:${session.accountId}`, {
      windowMs: 86_400_000,
      max: 20,
      onRedisError: "closed",
    });
    if (!quota.success) {
      return errorResponse("오늘 테스트 발송 한도(20건)를 초과했습니다. 내일 다시 시도해주세요.", 429);
    }

    // H-06: 본인 연락처로만 발송.
    const to = (channel === "email" ? session.email : session.phone) || "";
    if (!to) {
      return errorResponse(
        channel === "email"
          ? "본인 이메일이 없습니다. 계정 설정에서 이메일을 등록해주세요."
          : "본인 휴대폰 번호가 없습니다. 계정 설정에서 번호를 등록한 뒤 테스트해주세요.",
        400,
      );
    }

    const name = session.name || "고객";
    const personalize = (t: string) => personalizeName(t, name);
    // §3-1: 채널·목적으로 서버 판정(테스트도 동일 규칙 — 광고성 테스트는 게이트 통과 여부까지 확인).
    const { messageType } = deriveMessageType(channel, b.purpose);

    // 3.4a 재배선: flag on 시 v2 dispatch(단발)로 발송. provider 스텁이면 502(PROVIDER_UNWIRED).
    if (isOrganizerMessagingV2Enabled()) {
      try {
        const v2 = await testSendOrganizerMessage({
          go_account_id: session.accountId,
          channel: b.channel,
          to,
          title: `[테스트] ${personalize(b.title)}`,
          body: personalize(b.body),
          message_type: messageType,
          template_code: b.templateCode,
        });
        logger.info("테스트 발송(v2)", {
          source: "messages-test", accountId: session.accountId, userId: session.id,
          eventId: params.eventId, channel, status: v2.status,
        });
        return successResponse({ status: v2.status, to });
      } catch (err: unknown) {
        if (err instanceof V2CommerceError) {
          if (err.status === 422) return errorResponse(`발송 게이트에서 제외됨`, 422);
          if (err.status === 502) return errorResponse(`발송 실패(발송 채널 배선 대기 중입니다)`, 502);
        }
        return errorResponse(ERR.SERVER, 500);
      }
    }

    const result = await dispatchOne({
      accountId: session.accountId,
      channel,
      messageType,
      to,
      subject: `[테스트] ${personalize(b.title)}`,
      body: personalize(b.body),
      templateCode: b.templateCode,
    });

    // H-06: 감사 로그 — 누가·어느 이벤트·어느 채널로 테스트 발송했는지 기록.
    logger.info("테스트 발송", {
      source: "messages-test",
      accountId: session.accountId,
      userId: session.id,
      eventId: params.eventId,
      channel,
      status: result.status,
    });

    if (result.status === "sent") return successResponse({ status: "sent", to });
    if (result.status === "skipped") return errorResponse(`발송 게이트에서 제외됨: ${result.reason}`, 422);
    return errorResponse(`발송 실패: ${result.error}`, 502);
  } catch (err) {
    if (err instanceof z.ZodError) return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    // fail-closed: 수신거부/수신동의 판정 실패는 500(영구실패)이 아니라 **503**(재시도 가능).
    if (err instanceof V2MessagingComplianceError) return errorResponse(err.message, 503);
    if (err instanceof EventAccessError) {
      return err.reason === "not_found"
        ? errorResponse(ERR.NOT_FOUND, 404)
        : errorResponse("커머스 서버에 연결할 수 없습니다", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

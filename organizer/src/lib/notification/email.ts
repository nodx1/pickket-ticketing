/**
 * 이메일 발송 — NCP Cloud Outbound Mailer.
 *
 * 발신주소(senderAddress)는 콘솔에서 도메인 인증(SPF/DKIM/DMARC + 소유권 토큰) + 발신주소 등록이
 * 선행되어야 한다(pickket.kr). serviceId 는 필요 없음.
 * env: NCP_ACCESS_KEY/NCP_SECRET_KEY(공통), MAILER_SENDER_ADDRESS(support@pickket.kr), MAILER_SENDER_NAME(선택)
 */
import { logger } from "@/lib/logger";
import { getRuntimeEnv } from "@/lib/env.runtime";
import { getNcpCreds, ncpJsonRequest, NCP_MAILER_HOST } from "@/lib/ncp/client";

const MAILER_URI = "/api/v1/mails";

interface SendEmailParams {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  idempotencyKey?: string;
  /**
   * 회신 주소. 발신은 pickket.kr 인증 도메인 고정이지만, 주최자↔소비자 릴레이에서
   * 수신자가 "회신"하면 주최자에게 닿도록 replyToAddress 를 지정한다. NCP 가 이 필드를
   * 무시하더라도 호출부가 본문 푸터에 회신처를 병기하므로 도달성은 보장된다.
   */
  replyTo?: string;
}

export async function sendEmail({ to, subject, bodyHtml, bodyText: _bodyText, idempotencyKey, replyTo }: SendEmailParams) {
  const creds = getNcpCreds();
  const senderAddress = getRuntimeEnv("MAILER_SENDER_ADDRESS");

  if (!creds || !senderAddress) {
    // 프로덕션에서 미설정을 조용히 성공 처리하면 "발송됨" 표시 뒤 무음 장애가 된다.
    // 시뮬레이션은 개발 환경에서만 허용.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NCP Outbound Mailer 미설정(NCP_ACCESS_KEY/NCP_SECRET_KEY/MAILER_SENDER_ADDRESS)으로 이메일을 발송할 수 없습니다",
      );
    }
    logger.warn("이메일 발송 시뮬레이션 (NCP 미설정, 개발 환경 전용)", { to, subject });
    return { success: true, simulated: true };
  }

  const result = await ncpJsonRequest<{ requestId: string; count: number }>(
    NCP_MAILER_HOST,
    "POST",
    MAILER_URI,
    {
      senderAddress,
      senderName: getRuntimeEnv("MAILER_SENDER_NAME") || "PICKKET",
      title: subject,
      body: bodyHtml,
      recipients: [{ address: to, type: "R" }],
      individual: true, // 개별 발송 — 수신자끼리 서로 노출 안 됨
      ...(replyTo ? { replyToAddress: replyTo } : {}),
    },
    creds,
    { idempotencyKey },
  );

  logger.info("이메일 발송 성공(NCP)", { to, requestId: result.requestId });
  return { success: true, simulated: false, requestId: result.requestId };
}

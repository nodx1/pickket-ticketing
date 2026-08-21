/**
 * NCP SENS SMS provider — OTP 등 인증 SMS 발송.
 * env: NCP_ACCESS_KEY/NCP_SECRET_KEY(공통), SENS_SMS_SERVICE_ID, SENS_SMS_FROM(등록 발신번호)
 * SMS_PROVIDER=ncp(또는 sens) 로 선택.
 */
import { logger } from "@/lib/logger";
import { getRuntimeEnv } from "@/lib/env.runtime";
import { getNcpCreds, ncpJsonRequest, NCP_SENS_HOST } from "@/lib/ncp/client";
import type { SmsProvider, SmsSendParams, SmsSendResult } from "./provider";

const onlyDigits = (v: string) => v.replace(/[^0-9]/g, "");

/** NCP SENS SMS 자격증명(공통 인증키 + serviceId + 발신번호) 완비 여부. */
export function hasSensCredentials(): boolean {
  return Boolean(
    getNcpCreds() && getRuntimeEnv("SENS_SMS_SERVICE_ID") && getRuntimeEnv("SENS_SMS_FROM"),
  );
}

/**
 * 배치 발송 — SENS `messages[]` 에 수신자별 개인화 content 를 담아 한 콜로 전송(청크 ~100/콜).
 * 응답 requestId 는 배치 단위. 개별 도달 여부는 DLR(상태 API)로 사후 대사.
 */
export async function sendSmsBatch(
  items: Array<{ to: string; content: string }>,
  options: { idempotencyKey?: string } = {},
): Promise<{ requestId: string; count: number }> {
  if (items.length === 0) return { requestId: "", count: 0 };
  const creds = getNcpCreds();
  const serviceId = getRuntimeEnv("SENS_SMS_SERVICE_ID");
  const from = getRuntimeEnv("SENS_SMS_FROM");
  if (!creds || !serviceId || !from) {
    throw new Error("NCP SENS SMS 자격증명 미설정(SENS_SMS_SERVICE_ID/SENS_SMS_FROM)");
  }

  const uri = `/sms/v2/services/${serviceId}/messages`;
  // 타입은 배치 내 가장 긴 본문 기준(하나라도 90바이트 초과면 LMS).
  const maxBytes = Math.max(...items.map((i) => Buffer.byteLength(i.content, "utf8")));
  const type = maxBytes > 90 ? "LMS" : "SMS";
  const messages = items.map((i) => ({ to: onlyDigits(i.to), content: i.content }));

  const result = await ncpJsonRequest<{ requestId: string; statusName: string }>(
    NCP_SENS_HOST,
    "POST",
    uri,
    { type, from: onlyDigits(from), content: items[0].content, messages },
    creds,
    { idempotencyKey: options.idempotencyKey },
  );
  logger.info("[sms-ncp] 배치발송", { requestId: result.requestId, count: items.length });
  return { requestId: result.requestId, count: items.length };
}

export const sensProvider: SmsProvider = {
  name: "ncp",
  async send({ to, body }: SmsSendParams): Promise<SmsSendResult> {
    const creds = getNcpCreds();
    const serviceId = getRuntimeEnv("SENS_SMS_SERVICE_ID");
    const from = getRuntimeEnv("SENS_SMS_FROM");
    if (!creds || !serviceId || !from) {
      throw new Error("NCP SENS SMS 자격증명 미설정(SENS_SMS_SERVICE_ID/SENS_SMS_FROM)");
    }

    const uri = `/sms/v2/services/${serviceId}/messages`;
    const type = Buffer.byteLength(body, "utf8") > 90 ? "LMS" : "SMS";

    const result = await ncpJsonRequest<{ requestId: string; statusCode: string; statusName: string }>(
      NCP_SENS_HOST,
      "POST",
      uri,
      { type, from: onlyDigits(from), content: body, messages: [{ to: onlyDigits(to) }] },
      creds,
    );

    logger.info("[sms-ncp] 발송", { requestId: result.requestId, status: result.statusName });
    return {
      success: true,
      messageId: result.requestId,
      provider: "ncp",
      rawResponse: result as unknown as Record<string, unknown>,
    };
  },
};

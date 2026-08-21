/**
 * SMS 발송(캠페인·알림) — NCP SENS SMS v2.
 * env: NCP_ACCESS_KEY/NCP_SECRET_KEY(공통), SENS_SMS_SERVICE_ID, SENS_SMS_FROM(콘솔 등록 발신번호)
 * 90바이트(한글 약 45자) 초과 시 자동 LMS 로 전환.
 */
import { logger } from "@/lib/logger";
import { getRuntimeEnv } from "@/lib/env.runtime";
import { getNcpCreds, ncpJsonRequest, NCP_SENS_HOST } from "@/lib/ncp/client";

interface SendSMSParams {
  to: string;
  body: string;
  idempotencyKey?: string;
}

const onlyDigits = (v: string) => v.replace(/[^0-9]/g, "");

export async function sendSMS({ to, body, idempotencyKey }: SendSMSParams) {
  const creds = getNcpCreds();
  const serviceId = getRuntimeEnv("SENS_SMS_SERVICE_ID");
  const from = getRuntimeEnv("SENS_SMS_FROM");

  if (!creds || !serviceId || !from) {
    // 프로덕션에서 미설정을 조용히 성공 처리하면 운영자가 "발송됨"을 믿는 무음 장애가 된다.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NCP SENS SMS 미설정(NCP_ACCESS_KEY/NCP_SECRET_KEY/SENS_SMS_SERVICE_ID/SENS_SMS_FROM)으로 SMS를 발송할 수 없습니다",
      );
    }
    logger.warn("SMS 발송 시뮬레이션 (NCP 미설정, 개발 환경 전용)", { to, bodyLength: body.length });
    return { success: true, simulated: true };
  }

  const uri = `/sms/v2/services/${serviceId}/messages`;
  const type = Buffer.byteLength(body, "utf8") > 90 ? "LMS" : "SMS";

  const result = await ncpJsonRequest<{ requestId: string; statusCode: string; statusName: string }>(
    NCP_SENS_HOST,
    "POST",
    uri,
    {
      type,
      from: onlyDigits(from),
      content: body,
      messages: [{ to: onlyDigits(to) }],
    },
    creds,
    { idempotencyKey },
  );

  logger.info("SMS 발송(NCP SENS)", { to, type, requestId: result.requestId, status: result.statusName });
  return { success: true, simulated: false, requestId: result.requestId };
}

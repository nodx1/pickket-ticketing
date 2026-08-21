/**
 * Stub SMS provider — 실제 발송 없음.
 *
 * Solapi/NCP 계약 전 개발/테스트용.
 * 콘솔 출력 + logger.warn으로 발송 내역 기록. 실 SMS는 안 나감.
 *
 * PLAYWRIGHT_TEST=1 또는 SMS_PROVIDER=stub 일 때 사용됨.
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";
import type { SmsProvider, SmsSendParams, SmsSendResult } from "./provider";

export const stubSmsProvider: SmsProvider = {
  name: "stub",
  async send(params: SmsSendParams): Promise<SmsSendResult> {
    const messageId = `stub_${crypto.randomBytes(6).toString("hex")}`;

    // 콘솔에 대놓고 출력 (개발자가 테스트 OTP를 바로 볼 수 있게)
    const masked = params.to.slice(0, -4) + "****";
    logger.warn("[sms-stub] 📱 실제 발송 없음 — 콘솔 전용", {
      to: masked,
      body: params.body,
      messageId,
    });
    console.warn(
      `\n📱 [SMS STUB] To: ${params.to}\n📱 [SMS STUB] Body: ${params.body}\n📱 [SMS STUB] MessageID: ${messageId}\n`,
    );

    return {
      success: true,
      messageId,
      provider: "stub",
      rawResponse: { mode: "stub", to: params.to },
    };
  },
};

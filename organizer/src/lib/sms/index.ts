/**
 * SMS provider factory.
 *
 * 환경변수 SMS_PROVIDER로 선택. 기본 'stub'.
 *
 * 전환 방법:
 *   - 개발/테스트: SMS_PROVIDER=stub (콘솔 출력만)
 *   - 운영 (Solapi 계약 후): SMS_PROVIDER=solapi
 *   - 향후 NCP/Twilio 추가 시 여기에 case 추가
 */
import type { SmsProvider } from "./provider";
import { stubSmsProvider } from "./stub";
import { solapiProvider } from "./solapi";
import { sensProvider, hasSensCredentials } from "./sens";
import { getRuntimeEnv } from "@/lib/env.server";
import { logger } from "@/lib/logger";
import { hasSolapiCredentials } from "@/lib/solapi";

export function getSmsProvider(): SmsProvider {
  const envProvider = (getRuntimeEnv("SMS_PROVIDER") ?? "stub").toLowerCase();

  switch (envProvider) {
    case "stub":
      return stubSmsProvider;
    case "ncp":
    case "sens":
      if (hasSensCredentials()) {
        return sensProvider;
      }
      logger.warn("[sms-factory] NCP SENS 자격 증명이 없어 stub으로 폴백합니다.");
      return stubSmsProvider;
    case "solapi":
      if (hasSolapiCredentials({ requireSender: true })) {
        return solapiProvider;
      }
      logger.warn("[sms-factory] Solapi 자격 증명이 없어 stub으로 폴백합니다.");
      return stubSmsProvider;
    default:
      logger.warn(`[sms-factory] 알 수 없는 SMS_PROVIDER='${envProvider}'. stub으로 폴백.`);
      return stubSmsProvider;
  }
}

export { solapiProvider, stubSmsProvider, sensProvider };
export type { SmsProvider, SmsSendParams, SmsSendResult } from "./provider";

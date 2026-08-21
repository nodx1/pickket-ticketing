import type { SmsProvider, SmsSendParams, SmsSendResult } from "./provider";
import { logger } from "@/lib/logger";
import {
  extractSolapiMessageId,
  hasSolapiCredentials,
  sendSolapiMessage,
} from "@/lib/solapi";

export const solapiProvider: SmsProvider = {
  name: "solapi",
  async send(params: SmsSendParams): Promise<SmsSendResult> {
    if (!hasSolapiCredentials({ requireSender: true })) {
      logger.error("[solapi] 자격 증명이 누락되어 SMS 발송을 진행할 수 없습니다.");
      throw new Error("Solapi credentials are incomplete.");
    }

    const body = await sendSolapiMessage({
      to: params.to,
      text: params.body,
      autoTypeDetect: false,
    });

    return {
      success: true,
      messageId: extractSolapiMessageId(body) ?? `solapi_${Date.now()}`,
      provider: "solapi",
      rawResponse: body,
    };
  },
};

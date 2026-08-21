import crypto from "node:crypto";
import { getRuntimeEnv } from "@/lib/env.server";

const DEFAULT_SOLAPI_API_BASE_URL = "https://api.solapi.com";

export interface SolapiConfig {
  apiBaseUrl: string;
  apiKey: string;
  apiSecret: string;
  senderPhone: string;
  pfId: string;
}

export function getSolapiConfig(): SolapiConfig {
  return {
    apiBaseUrl: (getRuntimeEnv("SOLAPI_API_BASE_URL") ?? DEFAULT_SOLAPI_API_BASE_URL).replace(/\/$/, ""),
    apiKey: getRuntimeEnv("SOLAPI_API_KEY") ?? "",
    apiSecret: getRuntimeEnv("SOLAPI_API_SECRET") ?? "",
    senderPhone: getRuntimeEnv("SOLAPI_SENDER_PHONE") ?? "",
    pfId: getRuntimeEnv("SOLAPI_PF_ID") ?? "",
  };
}

export function hasSolapiCredentials({ requireSender = false }: { requireSender?: boolean } = {}) {
  const config = getSolapiConfig();
  return Boolean(config.apiKey && config.apiSecret && (!requireSender || config.senderPhone));
}

export function createSolapiAuthorization(apiKey: string, apiSecret: string) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(date + salt)
    .digest("hex");

  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function parseJsonBody(text: string): Record<string, unknown> {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function extractErrorMessage(body: Record<string, unknown>) {
  const candidates = [
    body.errorMessage,
    body.message,
    body.error,
    typeof body.error === "object" && body.error !== null
      ? (body.error as Record<string, unknown>).message
      : undefined,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

export async function sendSolapiMessage(message: Record<string, unknown>) {
  const config = getSolapiConfig();
  if (!config.apiKey || !config.apiSecret || !config.senderPhone) {
    throw new Error("Solapi 자격 증명이 완전하지 않습니다");
  }

  const response = await fetch(`${config.apiBaseUrl}/messages/v4/send`, {
    method: "POST",
    headers: {
      Authorization: createSolapiAuthorization(config.apiKey, config.apiSecret),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        from: config.senderPhone,
        ...message,
      },
    }),
  });

  const body = parseJsonBody(await response.text());
  if (!response.ok) {
    throw new Error(extractErrorMessage(body) ?? `Solapi 발송 실패 (HTTP ${response.status})`);
  }

  return body;
}

export function extractSolapiMessageId(body: Record<string, unknown>): string | undefined {
  const directCandidates = [body.messageId, body.message_id, body.id, body.groupId];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== "object") {
        continue;
      }

      const messageRecord = message as Record<string, unknown>;
      const nestedCandidates = [
        messageRecord.messageId,
        messageRecord.message_id,
        messageRecord.id,
      ];
      for (const candidate of nestedCandidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          return candidate.trim();
        }
      }
    }
  }

  return undefined;
}

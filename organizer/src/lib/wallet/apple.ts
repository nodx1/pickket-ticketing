import { getRuntimeEnv } from "@/lib/env.server";
import { logger } from "@/lib/logger";

export interface ApplePassData {
  ticketId: string;
  eventTitle: string;
  eventDate: string;
  venueName: string;
  attendeeName: string;
  ticketNumber: string;
}

let loggedDisableReason: string | null = null;

function logAppleWalletDisabled(reason: string) {
  if (loggedDisableReason === reason) {
    return;
  }

  loggedDisableReason = reason;
  logger.info("[apple-wallet] 패스 생성을 비활성화합니다", { reason });
}

export async function generateApplePass(data: ApplePassData): Promise<Buffer | null> {
  void data;
  const certificate = getRuntimeEnv("APPLE_PASS_CERT");
  const privateKey = getRuntimeEnv("APPLE_PASS_KEY");
  if (!certificate || !privateKey) {
    logAppleWalletDisabled("credentials_missing");
    return null;
  }

  try {
    await import(/* webpackIgnore: true */ "passkit-generator" as string);
    logAppleWalletDisabled("pass_template_unconfigured");
    return null;
  } catch {
    logAppleWalletDisabled("passkit_generator_missing");
    return null;
  }
}

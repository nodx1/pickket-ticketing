import crypto from "node:crypto";
import fs from "node:fs";
import { sendAlimtalkBatch } from "@/lib/notification/alimtalk";
import { sendSmsBatch } from "@/lib/sms/sens";
import { sendEmail } from "@/lib/notification/email";
import { lookupMailerDeliveryStatus, lookupSensDeliveryStatus } from "@/lib/notification/dlr";
import { getTossPaymentByPaymentKey, tossProvider } from "@/lib/payment/toss";
import { assertSandboxOperation, isSandboxDryRun, type SandboxOperation, type SandboxProvider } from "@/lib/provider-sandbox-policy";
import { loadLocalEnv, parsePositiveInt } from "./ops/env";

loadLocalEnv();

type Provider = SandboxProvider;
type Operation = SandboxOperation;
const args = new Map(process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
  const [key, ...rest] = arg.slice(2).split("=");
  return [key, rest.join("=") || "true"] as const;
}));
const provider = (args.get("provider") ?? process.env.PROVIDER_SANDBOX_PROVIDER ?? "sms") as Provider;
const operation = (args.get("operation") ?? "send") as Operation;
const count = parsePositiveInt("PROVIDER_SANDBOX_COUNT", 1, 10);
const recipient = process.env.PROVIDER_SANDBOX_RECIPIENT?.trim();
const requestId = args.get("request-id") ?? process.env.PROVIDER_SANDBOX_REQUEST_ID;
const dryRun = isSandboxDryRun(args.get("dry-run") ?? process.env.PROVIDER_SANDBOX_DRY_RUN);

if (!["sms", "alimtalk", "mailer", "toss"].includes(provider)) throw new Error("provider는 sms|alimtalk|mailer|toss 중 하나여야 합니다");
if (!["send", "status", "cancel"].includes(operation)) throw new Error("operation은 send|status|cancel 중 하나여야 합니다");
assertSandboxOperation(provider, operation);

function assertSendGuard() {
  if (dryRun) return;
  if (process.env.PROVIDER_SANDBOX_CONFIRM !== "I_UNDERSTAND") {
    throw new Error("실제 발송은 PROVIDER_SANDBOX_CONFIRM=I_UNDERSTAND가 필요합니다");
  }
  if (!recipient) throw new Error("PROVIDER_SANDBOX_RECIPIENT가 필요합니다");
  const allowed = process.env.PROVIDER_SANDBOX_ALLOWED_RECIPIENT?.trim();
  if (!allowed || recipient !== allowed) throw new Error("수신자는 PROVIDER_SANDBOX_ALLOWED_RECIPIENT와 정확히 일치해야 합니다");
}

function assertCancelGuard() {
  if (dryRun) return;
  if (process.env.PROVIDER_SANDBOX_CONFIRM !== "I_UNDERSTAND") {
    throw new Error("실제 취소는 PROVIDER_SANDBOX_CONFIRM=I_UNDERSTAND가 필요합니다");
  }
  if (provider === "toss" && !process.env.PROVIDER_SANDBOX_PAYMENT_KEY?.trim()) {
    throw new Error("PROVIDER_SANDBOX_PAYMENT_KEY가 필요합니다");
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, "[phone]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
}

async function sendOne() {
  assertSendGuard();
  if (dryRun) return { dryRun: true, provider, operation: "send" as const };
  // All repetitions represent one logical send so provider-side dedupe can be
  // compared with the returned request IDs.
  const key = `sandbox:${provider}:${crypto.createHash("sha256").update(recipient!).digest("hex").slice(0, 24)}`;
  if (provider === "sms") return sendSmsBatch([{ to: recipient!, content: process.env.PROVIDER_SANDBOX_MESSAGE ?? "PICKKET sandbox verification" }], { idempotencyKey: key });
  if (provider === "alimtalk") return sendAlimtalkBatch(
    process.env.PROVIDER_SANDBOX_TEMPLATE_CODE ?? "PICKKET_PURCHASE_001",
    [{ to: recipient!, content: process.env.PROVIDER_SANDBOX_MESSAGE ?? "PICKKET sandbox verification" }],
    { idempotencyKey: key },
  );
  if (provider === "mailer") return sendEmail({
    to: recipient!,
    subject: process.env.PROVIDER_SANDBOX_SUBJECT ?? "PICKKET sandbox verification",
    bodyHtml: process.env.PROVIDER_SANDBOX_MESSAGE ?? "PICKKET sandbox verification",
    idempotencyKey: key,
  });
  const paymentKey = process.env.PROVIDER_SANDBOX_PAYMENT_KEY;
  if (!paymentKey) throw new Error("PROVIDER_SANDBOX_PAYMENT_KEY가 필요합니다");
  return tossProvider.cancel({ paymentKey, reason: process.env.PROVIDER_SANDBOX_CANCEL_REASON ?? "sandbox verification", amount: Number(process.env.PROVIDER_SANDBOX_CANCEL_AMOUNT ?? 0) || undefined });
}

async function cancelOne() {
  assertCancelGuard();
  if (dryRun) return { dryRun: true, provider, operation: "cancel" as const };
  const paymentKey = process.env.PROVIDER_SANDBOX_PAYMENT_KEY!;
  return tossProvider.cancel({
    paymentKey,
    reason: process.env.PROVIDER_SANDBOX_CANCEL_REASON ?? "sandbox verification",
    amount: Number(process.env.PROVIDER_SANDBOX_CANCEL_AMOUNT ?? 0) || undefined,
  });
}

async function status() {
  if (!requestId) throw new Error("--request-id 또는 PROVIDER_SANDBOX_REQUEST_ID가 필요합니다");
  const target = recipient ?? "sandbox-recipient";
  if (provider === "sms" || provider === "alimtalk") return lookupSensDeliveryStatus(provider === "sms" ? "sms" : "kakao", requestId);
  if (provider === "mailer") return lookupMailerDeliveryStatus(requestId, target);
  const paymentKey = process.env.PROVIDER_SANDBOX_PAYMENT_KEY ?? requestId;
  return getTossPaymentByPaymentKey(paymentKey);
}

const startedAt = new Date().toISOString();
async function main() {
  let result: unknown;
  let hasOperationFailure = false;
  if (operation === "status") {
    result = await status();
  } else if (operation === "cancel") {
    result = await cancelOne();
  } else {
    const outputs = await Promise.all(Array.from({ length: count }, () => sendOne().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error: errorMessage(error) }),
    )));
    hasOperationFailure = outputs.some((output) => !output.ok);
    result = outputs;
  }

  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    provider,
    operation,
    count: operation === "status" ? 1 : count,
    recipient: recipient ? "[configured allowlisted recipient]" : undefined,
    result,
    dryRun,
    note: operation === "send" && count > 1 ? "NCP 공식 exactly-once 지원은 이 도구가 주장하지 않으며, provider request IDs와 실제 수신 건수를 대조해야 합니다." : undefined,
  };
  const serialized = JSON.stringify(report, null, 2);
  console.log(serialized);
  const outputPath = process.env.PROVIDER_SANDBOX_OUTPUT?.trim();
  if (outputPath) fs.writeFileSync(outputPath, `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
  if (hasOperationFailure) process.exitCode = 1;
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});

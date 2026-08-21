export type SandboxProvider = "sms" | "alimtalk" | "mailer" | "toss";
export type SandboxOperation = "send" | "status" | "cancel";

export function assertSandboxOperation(
  provider: SandboxProvider,
  operation: SandboxOperation,
): void {
  if (operation === "cancel" && provider !== "toss") {
    throw new Error("cancel은 Toss provider에서만 지원됩니다");
  }
  if (operation === "send" && provider === "toss") {
    throw new Error("Toss sandbox send는 지원되지 않습니다. 기존 paymentKey에 cancel 또는 status를 사용하세요");
  }
}

export function isSandboxDryRun(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

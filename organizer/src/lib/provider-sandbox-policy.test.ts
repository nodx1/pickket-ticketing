import { describe, expect, it } from "vitest";
import { assertSandboxOperation, isSandboxDryRun } from "./provider-sandbox-policy";

describe("provider sandbox policy", () => {
  it("does not allow non-Toss cancellation to fall through to send", () => {
    expect(() => assertSandboxOperation("sms", "cancel")).toThrow(/Toss/);
    expect(() => assertSandboxOperation("mailer", "cancel")).toThrow(/Toss/);
    expect(() => assertSandboxOperation("toss", "cancel")).not.toThrow();
    expect(() => assertSandboxOperation("toss", "send")).toThrow(/paymentKey/);
  });

  it("recognizes explicit dry-run values only", () => {
    expect(isSandboxDryRun("1")).toBe(true);
    expect(isSandboxDryRun("TRUE")).toBe(true);
    expect(isSandboxDryRun("yes")).toBe(true);
    expect(isSandboxDryRun("on")).toBe(false);
    expect(isSandboxDryRun(undefined)).toBe(false);
  });
});

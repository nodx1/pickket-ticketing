import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { paymentAttemptView } from "@/lib/orders/payment-attempt-label";
import type { PaymentAttemptSummary } from "@/lib/orders/payment-attempt-label";

/**
 * 🔴 「결제창 이탈」과 「결제 실패」 (2026-08-10)
 *
 * 오늘 민원 3건이 **전부 이탈**이었는데 v2 DB 를 파야 확인됐다. 대회 3일간 반복되면
 * 감당이 안 된다.
 */
function s(over: Partial<PaymentAttemptSummary> = {}): PaymentAttemptSummary {
  return {
    attempt_count: 0, last_status: null, last_error_kind: null,
    last_error: null, last_at: null, ...over,
  };
}

describe("🔴 이탈과 실패를 가른다", () => {
  it("🔴 시도 0건 → '결제창에서 나감'", () => {
    const v = paymentAttemptView(s({ attempt_count: 0 }), "pending");
    expect(v.kind).toBe("abandoned");
    expect(v.label).toBe("결제창에서 나감");
  });

  it("🔴 failed → '결제 실패' — 이탈과 **다른 문구**여야 한다", () => {
    const v = paymentAttemptView(s({ attempt_count: 1, last_status: "failed" }), "pending");
    expect(v.kind).toBe("failed");
    expect(v.label).toContain("결제 실패");
    expect(v.label).not.toBe("결제창에서 나감");
  });

  it("분류가 있으면 사유를 덧붙인다", () => {
    expect(paymentAttemptView(s({
      attempt_count: 1, last_status: "failed", last_error_kind: "pg_declined",
    }), "pending").label).toBe("결제 실패 (카드사 거절)");
    expect(paymentAttemptView(s({
      attempt_count: 1, last_status: "failed", last_error_kind: "timeout",
    }), "pending").label).toBe("결제 실패 (응답 지연)");
  });

  it("모르는 분류면 사유 없이 '결제 실패' 만", () => {
    expect(paymentAttemptView(s({
      attempt_count: 1, last_status: "failed", last_error_kind: "unknown",
    }), "pending").label).toBe("결제 실패");
  });

  it("succeeded 는 아무 말도 하지 않는다 (기존 상태가 이미 정확하다)", () => {
    expect(paymentAttemptView(s({ attempt_count: 1, last_status: "succeeded" }), "pending").label).toBeNull();
  });

  it("🔴 구버전 v2(undefined)면 **아무 말도 하지 않는다**", () => {
    // 모르는데 "결제창에서 나감" 이라 하면 그게 오안내다 — 배포 순서가 어긋난 순간
    // 전건이 이탈로 보인다.
    expect(paymentAttemptView(undefined, "pending").kind).toBe("unknown");
    expect(paymentAttemptView(undefined, "pending").label).toBeNull();
    expect(paymentAttemptView(null, "pending").label).toBeNull();
  });

  it("🔴 v2 원문(last_error)을 화면 문구에 넣지 않는다", () => {
    const v = paymentAttemptView(s({
      attempt_count: 1, last_status: "failed", last_error_kind: "pg_declined",
      last_error: "reconciliation: PG status failed",
    }), "pending");
    expect(v.label).not.toContain("reconciliation");
    expect(v.label).not.toContain("PG status");
  });
});

/** 배선 — 판정만 만들고 화면이 안 쓰면 아무 일도 안 일어난다. */
async function source(rel: string): Promise<string> {
  const raw = await readFile(new URL(rel, import.meta.url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe("🔴 배선", () => {
  it("목록 라우트가 판정을 내려보낸다", async () => {
    const s2 = await source("../../app/api/events/[eventId]/orders/route.ts");
    // 🔴 상태를 **함께** 넘겨야 한다 — 안 넘기면 초대권이 「결제창에서 나감」으로 뜬다.
    expect(s2).toMatch(/paymentAttemptView\(o\.payment_attempts,\s*o\.status\)/);
  });

  it("🔴 목록이 v2 **원문**을 그대로 내려보내지 않는다", async () => {
    const s2 = await source("../../app/api/events/[eventId]/orders/route.ts");
    expect(s2).not.toMatch(/last_error/);
  });

  it("상세 서버가 같은 판정을 쓴다", async () => {
    const s2 = await source("../server/orders.ts");
    expect(s2).toMatch(/paymentAttemptView\(detail\.payment_attempts,\s*header\.status\)/);
    // v2 앵커 미연결이면 undefined 로 — "이탈" 로 단정하지 않는다
    expect(s2).toMatch(/paymentAttemptView\(undefined,\s*header\.status\)/);
  });

  it("🔴 화면이 그 값을 쓴다 · 원문은 안 쓴다", async () => {
    const s2 = await source("../../app/(dashboard)/events/[eventId]/orders/[orderId]/page.tsx");
    expect(s2).toMatch(/detail\.paymentAttempt\?\.label/);
    expect(s2).not.toMatch(/last_error/);
  });

  it("🔴 주문 상태(status) 표시를 건드리지 않았다", async () => {
    const s2 = await source("../../app/(dashboard)/events/[eventId]/orders/[orderId]/page.tsx");
    expect(s2).toMatch(/ORDER_STATUS_LABELS\[String\(detail\.status\)\]/);
  });
});

/**
 * 🔴 배포 직후 프로덕션에서 잡은 결함 (2026-08-10).
 *
 * 초대권·수동발권·0원 주문은 결제창이 없어 시도가 영원히 0건이다. 상태를 안 보면
 * **발권이 끝난 주문**이 「결제창에서 나감」으로 뜬다. 실측 27건이 그 상태였다.
 */
describe("🔴 결제창을 안 거친 주문을 이탈이라고 하지 않는다", () => {
  const settled = ["completed", "refunded", "partially_refunded", "cancelled"];

  it.each(settled)("%s + 시도 0건 → 아무 말도 하지 않는다", (status) => {
    const v = paymentAttemptView(s({ attempt_count: 0 }), status);
    expect(v.label).toBeNull();
    expect(v.label).not.toBe("결제창에서 나감");
  });

  it("pending·expired 에서는 여전히 이탈로 뜬다", () => {
    for (const status of ["pending", "expired"]) {
      expect(paymentAttemptView(s({ attempt_count: 0 }), status).label).toBe("결제창에서 나감");
    }
  });

  it("🔴 상태와 무관하게 **실패는 실패다** — 확정 후 환불된 실패 시도를 삼키지 않는다", () => {
    const v = paymentAttemptView(s({ attempt_count: 1, last_status: "failed" }), "refunded");
    expect(v.label).toContain("결제 실패");
  });
});

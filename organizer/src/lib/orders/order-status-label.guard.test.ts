import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EVENT_STATUS_LABELS, ORDER_STATUS_LABELS } from "@/lib/constants";

/**
 * 🔴 주문 상태를 **이벤트 상태 라벨로** 그리지 않게 막는다 (2026-07-31 prod 실측).
 *
 * ## 무슨 일이 있었나
 * 주문 목록이 이렇게 그리고 있었다:
 *
 *     row.status === "completed"  →  <StatusBadge status="live" />   →  **"판매중"**
 *     row.status === "pending"    →  <StatusBadge status="draft" />  →  **"초안"**
 *
 * 대표가 주문 목록 화면을 보내줘서 알았다 — 카드로 결제 완료된 주문 두 건에
 * **「판매중」** 이 떠 있었다. 원장은 `completed / paid` 로 정확했고 **화면만 거짓말**이었다.
 *
 * 배지 **색**을 재활용하려고 이벤트용 컴포넌트를 갖다 썼는데 **라벨까지 따라온** 것이다.
 * `ORDER_STATUS_LABELS` 는 그때도 있었지만 **아무도 안 쓰고 있었다.**
 *
 * ## 왜 구조 가드인가
 * 두 라벨 집합은 타입이 달라 tsc 가 못 잡는다(둘 다 문자열 키). 단위 테스트도
 * 라벨 표 자체는 옳으므로 통과한다. 막아야 하는 건 **어느 표를 쓰는가** 다.
 */
const ORDERS_UI = path.join(
  process.cwd(),
  "src/app/(dashboard)/events/[eventId]/orders/_components/event-orders-client.tsx",
);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("주문 상태 라벨", () => {
  it("🔴 주문 목록이 이벤트용 StatusBadge 를 쓰지 않는다", () => {
    const src = stripComments(readFileSync(ORDERS_UI, "utf8"));
    expect(
      src.includes("StatusBadge"),
      "StatusBadge 는 이벤트 상태(live→'판매중')를 그린다. 주문에 쓰면 " +
        "결제 완료 주문에 '판매중' 이 뜬다. `ORDER_STATUS_LABELS` 를 쓸 것.",
    ).toBe(false);
  });

  it("주문 목록이 ORDER_STATUS_LABELS 를 쓴다", () => {
    expect(stripComments(readFileSync(ORDERS_UI, "utf8"))).toMatch(/ORDER_STATUS_LABELS/);
  });

  it("🔴 두 라벨 집합이 겹치는 문구를 갖지 않는다 — 겹치면 또 헷갈린다", () => {
    const shared = Object.values(ORDER_STATUS_LABELS).filter((v) =>
      (Object.values(EVENT_STATUS_LABELS) as string[]).includes(v),
    );
    expect(shared, `겹치는 라벨: ${shared.join(", ")}`).toEqual([]);
  });

  it("주문 상태 6종에 라벨이 다 있다 — 빠지면 원시 문자열이 화면에 뜬다", () => {
    for (const s of ["pending", "completed", "expired", "cancelled", "refunded", "partially_refunded"]) {
      expect(ORDER_STATUS_LABELS[s as keyof typeof ORDER_STATUS_LABELS], `누락: ${s}`).toBeTruthy();
    }
  });
});

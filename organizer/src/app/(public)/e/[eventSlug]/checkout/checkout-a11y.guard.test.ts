import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 🔴 **돈을 내는 화면**의 접근성 최소선을 고정한다 (2026-07-31 실측).
 *
 * KLPGA 관객은 중장년이 상당수다. 결제 3단계에서 실측으로 두 가지가 나왔다:
 *
 *   · 페이지에 **h1 이 하나도 없다** — 세 단계 전부 `CardTitle`(h3)로 시작한다.
 *     화면낭독기가 문서 구조를 못 잡고, 각 단계는 독립 페이지인데 최상위 제목이 없다.
 *   · **수량 버튼이 40×40** — Apple HIG 44pt · Material 48dp 미달.
 *     WCAG 2.2 AA(24px)는 통과하지만, 실제로 손이 큰 사람은 옆 버튼을 누른다.
 *     하필 **수량을 잘못 고르면 돈이 틀어지는** 자리다.
 *
 * ## 왜 소스 가드인가
 * 브라우저 실측이 정확하지만 배포 뒤에나 돈다. 여기서 **되돌리는 커밋**을 막는다.
 */
const CHECKOUT = path.join(process.cwd(), "src/app/(public)/e/[eventSlug]/checkout");

const STEPS: Array<[string, string]> = [
  ["1단계 티켓 선택", "_components/checkout-ticket-step.tsx"],
  ["2단계 구매자 정보", "details/_components/checkout-details-step.tsx"],
  ["3단계 결제", "payment/_components/checkout-payment-step.tsx"],
];

describe("결제 화면 접근성", () => {
  it.each(STEPS)("%s — 제목이 h1 이다", (_name, rel) => {
    const src = readFileSync(path.join(CHECKOUT, rel), "utf8");
    expect(
      src,
      "`CardTitle` 기본은 h3 다. 결제 각 단계는 독립 페이지이므로 최상위 제목이 있어야 한다 — " +
        '`<CardTitle as="h1">` 를 쓸 것.',
    ).toMatch(/<CardTitle as="h1"/);
  });

  it("🔴 수량 버튼이 44px 이상이다 — 잘못 누르면 결제 금액이 틀어진다", () => {
    const src = readFileSync(path.join(CHECKOUT, "_components/checkout-ticket-step.tsx"), "utf8");
    // `size="icon"`(size-10 = 40px) 만으로는 부족하다. 국소 확대 클래스가 붙어 있어야 한다.
    const steppers = src.split('aria-label="수량').length - 1;
    expect(steppers, "수량 증가·감소 버튼 2개를 찾지 못했다 — 이 가드가 헛돈다").toBe(2);
    expect(
      (src.match(/className="size-11"/g) ?? []).length,
      "수량 버튼은 `size-11`(44px) 이상이어야 한다. `size=\"icon\"` 기본은 40px 다.",
    ).toBeGreaterThanOrEqual(2);
  });

  it("좌석맵 온보딩이 되살아나지 않는다 — 좌석 없는 행사에도 떴다", () => {
    const src = readFileSync(path.join(CHECKOUT, "_components/checkout-ticket-step.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/<OnboardingTour/);
  });

  it("상품 설명 자리에 안내 문구를 지어내지 않는다", () => {
    const src = readFileSync(path.join(CHECKOUT, "_components/checkout-ticket-step.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/상품 설명이 없습니다/);
  });
});

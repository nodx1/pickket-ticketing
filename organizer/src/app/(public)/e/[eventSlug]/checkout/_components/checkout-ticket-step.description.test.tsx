// @vitest-environment jsdom
/**
 * 🔴 등급 설명이 **사기 전에** 보이는가 (2026-08-11, 대표 결정).
 *
 * ## 왜 중요한가
 * 등급명이 「주중권 (목 1R ~ 금 2R)」이라 **이틀로 읽힌다.** 실제로는 그 기간 중
 * **하루만** 입장한다(daypass — 첫 스캔 날짜로 확정). 이미 51장이 나가 있고,
 * 손님이 이틀로 알고 현장에 오면 되돌릴 방법이 없다.
 *
 * ⚠️ **화면에 문구를 박지 않는다.** 설명 필드가 이미 배선돼 있고 값만 비어 있다
 *    (2026-08-11 실측: 공개 API 가 `description` 키를 내려주고 값이 `""`).
 *    문구는 주최자 데이터로 넣고, 화면은 **있으면 그리고 없으면 안 그린다.**
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CheckoutTicketStep } from "./checkout-ticket-step";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/e/x/checkout",
}));

const DAYPASS = "8월 20일 ~ 23일 기간 중 하루 입장하실 수 있습니다";

type Product = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  stock: number | null;
  isOnSale?: boolean;
};

function renderStep(products: Product[]) {
  return render(
    <CheckoutTicketStep
      event={{ id: "ev-1", slug: "klpga", title: "KLPGA", products } as never}
    />,
  );
}

const BASE: Product = {
  id: "p1",
  name: "주중권 (목 1R ~ 금 2R)",
  description: null,
  price: 13500,
  stock: 100,
  isOnSale: true,
};

describe("🔴 등급 설명 — 주최자 데이터를 그대로 보여준다", () => {
  it("🔴 설명이 있으면 등급 카드에 뜬다", () => {
    renderStep([{ ...BASE, description: DAYPASS }]);
    expect(screen.getByText(DAYPASS), "설명이 화면에 없다 — 손님이 이틀로 안다").toBeInTheDocument();
  });

  it("🔴 설명이 없는 등급에는 아무것도 안 뜬다 — 빈 줄 금지", () => {
    const { container } = renderStep([{ ...BASE, description: null }]);
    expect(screen.queryByText(DAYPASS)).toBeNull();
    // 빈 <p> 가 자리를 먹지 않는지 — 텍스트 없는 문단이 없어야 한다.
    const emptyParas = [...container.querySelectorAll("p")].filter((p) => (p.textContent ?? "").trim() === "");
    expect(emptyParas, "빈 문단이 자리를 먹는다").toHaveLength(0);
  });

  it("🔴 등급마다 자기 설명을 보여준다 — 한 문구를 전부에 박으면 안 된다", () => {
    renderStep([
      { ...BASE, description: DAYPASS },
      { ...BASE, id: "p2", name: "주말권 (토 3R ~ 일 FR)", price: 22500, description: null },
    ]);
    // 하드코딩이면 설명 없는 주말권에도 같은 문구가 뜬다.
    expect(screen.getAllByText(DAYPASS)).toHaveLength(1);
  });

  it("빈 문자열도 없는 것으로 본다", () => {
    const { container } = renderStep([{ ...BASE, description: "" }]);
    const emptyParas = [...container.querySelectorAll("p")].filter((p) => (p.textContent ?? "").trim() === "");
    expect(emptyParas).toHaveLength(0);
  });

  it("설명을 우리가 가공하지 않는다 — 주최자가 쓴 그대로", () => {
    const raw = "8월 20일 ~ 23일 기간 중 **하루** 입장 · 재입장 가능";
    renderStep([{ ...BASE, description: raw }]);
    expect(screen.getByText(raw)).toBeInTheDocument();
  });
});

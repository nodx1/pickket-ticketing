// @vitest-environment jsdom
/**
 * 🔴 체크아웃 1단계 — 정가 취소선이 **판매가 옆에** 붙는가.
 *
 * ## 왜 화면 테스트가 따로 필요한가
 * `face-price.ts`(규칙)와 `events.ts`(배선)에 각각 테스트가 있지만, 그 둘이 다 통과해도
 * **화면이 그 함수를 안 부르면** 취소선은 안 뜬다. 배선 삭제 뮤테이션(M3)이 화면 쪽에서도
 * 죽어야 "양쪽에 테스트가 있다" 가 된다.
 *
 * ⚠️ `line-through` 클래스가 **있는지**가 아니라 **어떤 값에 붙었는지**를 본다.
 *    문자열 존재 검사는 값이 뒤바뀌어도 통과한다 — 오늘 이 프로젝트에서 네 번 뚫렸다.
 *
 * ⚠️ 상세 페이지(`page.tsx`)는 서버 컴포넌트이고 v2 왕복이 많아 여기서 렌더하지 않는다.
 *    같은 판정 함수(`strikethroughPrice`)를 쓰므로 규칙은 공유되고, 상세 쪽 배선은
 *    `events.test.ts` 가 값이 실려 오는 것까지 본다.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CheckoutTicketStep } from "./checkout-ticket-step";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/e/x/checkout",
}));

type Product = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  facePrice?: number | null;
  stock: number | null;
  taxIncluded?: boolean;
  isOnSale?: boolean;
};

function renderStep(products: Product[]) {
  return render(
    <CheckoutTicketStep
      event={
        {
          id: "ev-1",
          slug: "klpga",
          title: "BC카드·한경 제48회 KLPGA 챔피언십",
          products,
        } as never
      }
    />,
  );
}

const BASE: Product = {
  id: "p1",
  name: "주중권",
  description: null,
  price: 13500,
  stock: 100,
  taxIncluded: true,
  isOnSale: true,
};

/** 취소선이 붙은 요소들의 텍스트. */
function struck(): string[] {
  return screen.queryAllByTestId("face-price").map((el) => (el.textContent ?? "").trim());
}

describe("🔴 할인 중일 때 — 정가에 취소선", () => {
  it("정가가 취소선으로 뜨고, 판매가는 그대로 남는다", () => {
    renderStep([{ ...BASE, facePrice: 15000 }]);
    expect(struck(), "정가에 취소선이 안 붙었다").toEqual(["₩15,000"]);
    // 판매가는 취소선 밖에 살아 있어야 한다 — 둘 다 보여야 할인으로 읽힌다.
    expect(screen.getByText(/₩13,500/)).toBeInTheDocument();
  });

  it("🔴 취소선이 **정가**에 붙는다 — 판매가에 붙으면 정반대다", () => {
    renderStep([{ ...BASE, facePrice: 15000 }]);
    const marks = screen.queryAllByTestId("face-price");
    expect(marks).toHaveLength(1);
    expect(marks[0].className, "line-through 가 없다").toContain("line-through");
    expect(marks[0].textContent, "취소선이 판매가에 붙었다").toContain("15,000");
    expect(marks[0].textContent).not.toContain("13,500");
  });

  it("티어가 여럿이면 각자 자기 정가", () => {
    renderStep([
      { ...BASE, facePrice: 15000 },
      { ...BASE, id: "p2", name: "주말권", price: 22500, facePrice: 25000 },
    ]);
    expect(struck()).toEqual(["₩15,000", "₩25,000"]);
  });
});

describe("🔴 할인이 아닐 때 — 아무것도 안 그린다", () => {
  it("정가가 없으면(미시딩) 취소선 0", () => {
    renderStep([{ ...BASE }]);
    expect(struck(), "정가가 없는데 취소선이 떴다").toEqual([]);
    expect(screen.getByText(/₩13,500/)).toBeInTheDocument();
  });

  it("🔴 정가와 판매가가 같으면 취소선 0 — ~~₩13,500~~ ₩13,500 방지", () => {
    renderStep([{ ...BASE, price: 15000, facePrice: 15000 }]);
    expect(struck()).toEqual([]);
  });

  it("🔴 정가가 0 이면 취소선 0 — ~~₩0~~ 방지", () => {
    renderStep([{ ...BASE, facePrice: 0 }]);
    expect(struck()).toEqual([]);
  });

  it("섞여 있으면 할인 중인 티어만 그린다", () => {
    renderStep([
      { ...BASE, facePrice: 15000 },
      { ...BASE, id: "p2", name: "정가판매권", price: 30000, facePrice: null },
    ]);
    expect(struck(), "할인 아닌 티어에도 취소선이 붙었다").toEqual(["₩15,000"]);
  });
});

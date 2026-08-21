import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 🔴 체크아웃 이펙트 재발 방지 가드 (2026-07-30).
 *
 * 배경: 결제 스텝의 `useEffect` 가 ① 안에서 `persist.rehydrate()` 를 호출하고
 * ② deps 에 **객체 `buyerInfo`** 를 넣어 무한 렌더 루프가 났다(React #185).
 * 결과는 "오류 발생 · 페이지를 불러올 수 없습니다" = **판매 불가**.
 *
 * ## 왜 소스 문자열을 검사하는가
 * `checkout/**` 에는 컴포넌트 테스트가 없고, 렌더 테스트를 세워도 **"deps 가 매 렌더
 * 바뀌는가"** 는 잡히지 않는다(참조 안정성은 렌더 2회 이상을 실제 브라우저 조건에서
 * 돌려야 드러난다). 그래서 **위험 패턴 자체를 금지**하는 가드로 막는다.
 *
 * ⚠️ 이 가드는 "루프가 없다" 를 증명하지 않는다. **알려진 두 원인의 재도입을 막는다.**
 *    새로운 형태의 루프는 여전히 화면 검증으로만 잡힌다.
 */

const BASE = join(process.cwd(), "src/app/(public)/e/[eventSlug]/checkout");

function read(rel: string): string {
  return readFileSync(join(BASE, rel), "utf8");
}

/** 소스에서 주석을 제거한다 — 주석 안의 설명이 검사에 걸리면 안 된다. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * **`useEffect` 의** deps 배열 본문만 뽑는다.
 *
 * ⚠️ `useMemo`/`useCallback` 은 **제외**한다. 초안은 `}, [...])` 를 통째로 잡아
 *    `useMemo(… , [selectedItems])` 까지 실패시켰다 — 그건 루프가 아니다.
 *    메모는 **setState 를 하지 않으므로** 참조가 불안정하면 재계산만 낭비하고 끝난다.
 *    루프는 "이펙트가 상태를 바꾸고 그 상태가 자기 deps 를 바꿀 때"만 생긴다.
 *    ⟹ 가드는 **실제 위험(이펙트)** 만 겨눈다. 넓히면 거짓 실패로 신뢰를 잃는다.
 */
function effectDeps(src: string): string[] {
  const out: string[] = [];
  // `useEffect(` 이후 첫 `}, [ ... ])` 를 그 이펙트의 deps 로 본다.
  const re = /useEffect\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const rest = src.slice(m.index);
    const dm = /\}\s*,\s*\[([\s\S]*?)\]\s*\)/.exec(rest);
    if (dm) out.push(dm[1]);
  }
  return out;
}

const STEPS = [
  "payment/_components/checkout-payment-step.tsx",
  "details/_components/checkout-details-step.tsx",
  "_components/checkout-ticket-step.tsx",
] as const;

describe("체크아웃 이펙트 가드", () => {
  /**
   * 🔴 **철회된 단언 (2026-07-30)** — 여기 원래 이런 테스트가 있었다:
   *      `expect(src).not.toContain("persist.rehydrate")`
   *
   * 그 단언은 **틀렸다.** 루프는 ①rehydrate 와 ②객체 deps 가 **겹칠 때만** 난다.
   * ①을 금지한 결과 판정이 렌더 클로저 값으로 밀려나 **결제 진입이 10/10 장바구니로
   * 튕기는** 새 결함이 생겼다(`src/lib/checkout/hydration-order.test.ts` 가 기전 고정).
   *
   * ⚠️ 교훈: 가드는 내 가정을 **검증하지 않고 박아버린다.** 원인 축(②객체 deps)이 아닌
   *    상관 축(①호출 유무)을 금지하면, 가드가 그린인 채로 결함이 들어온다.
   *    ⟹ 아래는 원인 축만 금지하고, 판정이 **최신값을 읽는지**를 요구한다.
   */
  it("🔴 결제 스텝의 리다이렉트 판정은 getState() 로 최신값을 읽는다", () => {
    // skipHydration 이라 첫 렌더 클로저는 빈 상태다. 클로저로 판정하면 오판하고,
    // once-guard 가 그 오판을 고정한다.
    const src = stripComments(read("payment/_components/checkout-payment-step.tsx"));
    const effectBody = /if\s*\(redirectedRef\.current\)\s*return;([\s\S]*?)\}\s*,\s*\[/.exec(src);
    expect(effectBody, "리다이렉트 이펙트를 찾지 못했다").not.toBeNull();
    const body = effectBody![1];
    expect(body).toContain("useCheckoutStore.getState()");
    // 판정 인자가 클로저 변수(`selectedItems.length`)가 아니라 스토어 스냅샷이어야 한다.
    expect(body).toMatch(/itemCount:\s*\w+\.selectedItems\.length/);
    expect(body).not.toMatch(/itemCount:\s*selectedItems\.length/);
  });

  it("🔴 어떤 체크아웃 스텝도 deps 에 buyerInfo 객체를 넣지 않는다", () => {
    for (const rel of STEPS) {
      const src = stripComments(read(rel));
      for (const deps of effectDeps(src)) {
        const tokens = deps.split(",").map((t) => t.trim()).filter(Boolean);
        // `buyerInfo` 통째는 금지. `buyerInfo.buyerName` 처럼 필드 접근은 허용(원시값).
        expect(tokens, `${rel} 의 deps: [${deps.trim()}]`).not.toContain("buyerInfo");
      }
    }
  });

  it("🔴 deps 에 selectedItems·answers·selectedSeatIds 객체를 넣지 않는다", () => {
    // 같은 부류의 store 중첩 객체들 — rehydrate 마다 참조가 바뀐다(기전 테스트로 확인).
    const FORBIDDEN = ["selectedItems", "answers", "selectedSeatIds"];
    for (const rel of STEPS) {
      const src = stripComments(read(rel));
      for (const deps of effectDeps(src)) {
        const tokens = deps.split(",").map((t) => t.trim()).filter(Boolean);
        for (const bad of FORBIDDEN) {
          expect(tokens, `${rel} 의 deps: [${deps.trim()}]`).not.toContain(bad);
        }
      }
    }
  });

  it("🔴 결제 스텝은 판정 전에 복원을 보장한다 — 자식 순서에 의존하지 않는다", () => {
    // 종전엔 "자식(CheckoutProgress)이 먼저 복원한다" 는 React 순서에만 기댔다.
    // 그 전제는 참이지만 **부모가 읽는 값이 클로저면 무의미**했다. 이제 부모가
    // hasHydrated() 로 직접 확인하고, 아니면 스스로 복원한다.
    const src = stripComments(read("payment/_components/checkout-payment-step.tsx"));
    expect(src).toContain("persist.hasHydrated()");
    expect(src).toContain("persist.rehydrate()");
  });

  it("🔴 checkoutStore 는 동기 스토리지를 쓴다 — 결제 스텝 판정의 암묵 전제", () => {
    // 결제 스텝은 `rehydrate()` 를 await 하지 않고 곧바로 `getState()` 를 읽는다.
    // 그것이 성립하는 이유는 **sessionStorage 가 동기**라는 것 하나뿐이다.
    // ⚠️ 주석만 남기면 "전제가 바뀌면 조용히 깨지는" 형태가 된다 — 그래서 단언한다.
    //    비동기 스토리지로 바꾸면 여기서 걸리고, 결제 스텝을 onFinishHydration 기반으로
    //    다시 설계해야 한다(안 그러면 결제 진입이 장바구니로 튕기는 결함이 재발한다).
    const store = readFileSync(
      join(process.cwd(), "src/lib/stores/checkoutStore.ts"),
      "utf8",
    );
    expect(stripComments(store)).toContain("createJSONStorage(() => sessionStorage)");
  });

  it("체크아웃 스텝은 CheckoutProgress 를 렌더한다 — 단계 표시·복원 공통 경로", () => {
    const src = read("payment/_components/checkout-payment-step.tsx");
    expect(src).toContain("<CheckoutProgress");
    const progress = stripComments(read("_components/checkout-progress.tsx"));
    expect(progress).toContain("persist.rehydrate");
  });
});

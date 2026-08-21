import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * 🔴 취소 배선 — **라이브러리만 고치고 화면을 안 고치면 여기서 걸린다** (2026-08-08)
 *
 * `nicepayClose` 를 등록해도 그 통지를 화면이 안 받으면 아무 일도 안 일어난다:
 * processing 모달이 영구 고착해 **결제 버튼을 다시 못 누른다**.
 *
 * ⚠️ 호출부(`checkout-payment-step.tsx`)의 `catch` 는 **goPay 이전** 오류만 잡는다.
 *    goPay 는 제어를 SDK 에 넘기고 즉시 반환하고, 취소는 그 뒤에 전역 콜백으로 온다
 *    ⟹ 취소는 catch 에 **안 걸린다**. onCancel 이 유일한 통로다.
 *
 * ⚠️ 이 컴포넌트는 라우팅·주문 API·결제위젯이 딸려 와 단위 실행이 어렵다. 그래서
 *    **관계**를 본다 — "onCancel 이라는 글자가 있다" 가 아니라, *그 콜백 안에서
 *    잠금 둘이 실제로 풀리는가*.
 */
const STEP =
  "../../app/(public)/e/[eventSlug]/checkout/payment/_components/checkout-payment-step.tsx";

async function body(): Promise<string> {
  const raw = await readFile(new URL(STEP, import.meta.url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe("🔴 나이스 결제창 취소 → 화면 잠금 해제", () => {
  it("🔴 startNicePayment 에 onCancel 을 넘긴다", async () => {
    expect(await body()).toMatch(
      /startNicePayment\(\s*providerParams\s*,\s*\{[\s\S]*?onCancel\s*:/,
    );
  });

  it("🔴 onCancel 안에서 processing 과 submitLock 을 **둘 다** 푼다", async () => {
    // 하나만 풀면 버튼이 여전히 안 눌린다 — 둘이 함께 잠그기 때문이다.
    const m = (await body()).match(/onCancel\s*:\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,/);
    expect(m, "onCancel 콜백 본문을 못 찾았다").not.toBeNull();
    const inner = m![1]!;
    expect(inner, "🔴 processing 이 안 풀려 모달이 고착한다").toMatch(/setProcessing\(false\)/);
    expect(inner, "🔴 submitLock 이 안 풀려 버튼이 안 눌린다").toMatch(
      /submitLock\.current\s*=\s*false/,
    );
  });

  it("goPay 이전 오류 경로(catch)는 그대로 살아 있다", async () => {
    // 취소 배선을 넣으면서 기존 실패 처리를 지우면 안 된다.
    const s = await body();
    expect(s).toMatch(/catch\s*\(err: unknown\)[\s\S]{0,300}setProcessing\(false\)/);
  });
});

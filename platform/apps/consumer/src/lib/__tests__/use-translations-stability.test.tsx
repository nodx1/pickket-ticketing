/**
 * `useTranslations()` 가 돌려주는 `t` 는 리렌더 사이에 **같은 참조인가**.
 *
 * ## 왜 재는가
 * consumer 의 React Compiler error 8건이 전부 같은 모양이었다 — `useCallback` 안에서
 * `t` 를 쓰는데 deps 에 `t` 가 없다. 컴파일러가 시키는 대로 deps 에 넣으면 고쳐지는데,
 * 그 콜백들이 대개 `useEffect` 의 deps 이기도 하다:
 *
 * ```
 * const loadSeats = useCallback(..., [..., t]);
 * useEffect(() => { loadSeats(); }, [loadSeats]);     ← SeatPicker.tsx
 * ```
 *
 * `t` 가 매 렌더 새 참조라면 저건 **무한 재요청**이다. 그래서 심증 대신 쟀다.
 *
 * ## 🔴 결론 — 두 답이 다르다. 그게 이 파일의 핵심이다
 *
 * ```
 * 진짜 next-intl (4.8.3)   t 는 **안정 참조**다        → deps 에 넣어도 프로덕션은 안전
 * 테스트 전역 목            t 는 **매번 새 함수**다     → 같은 코드가 테스트에서만 폭주
 * ```
 *
 * `src/setupTests.ts:37` 의 목은 `useTranslations: (ns) => makeT(ns)` 라
 * **호출마다 새 함수**를 만든다. 그래서 "deps 에 t 를 넣어도 되나" 를 **테스트로는
 * 판정할 수 없다** — 테스트가 실패해도 프로덕션 버그라는 뜻이 아니고, 그 반대도 아니다.
 *
 * ⚠️ 처음에 이 목을 끄지 않고 재서 **"t 는 불안정하다" 고 잘못 결론냈다.** 렌더된 문자열이
 *    내가 준 messages 와 달라서("좌석 홀드: 05:04") 목을 의심하게 됐다.
 *    ⟹ 측정 대상이 진짜 모듈인지부터 확인할 것.
 *
 * ## 그래서 코드는 어떻게 고쳤나
 * deps 를 늘리는 대신 **번역을 콜백 밖으로** 뺐다(렌더 시점에 문자열로 뽑아 씀).
 * 어느 쪽이든 컴파일러는 통과하지만, 이쪽이 추가로 i18n 버그를 없앤다 —
 * 번역 문자열을 state 에 담아두면 **언어를 바꿔도 안 바뀐다**(category 목록의 "총 N건"이
 * 그랬다). 그리고 위의 목 문제와 무관해진다.
 */
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * 🔴 전역 목을 끈다 — 이 파일은 **진짜 next-intl** 을 재야 한다.
 *    (파일 로컬 `vi.mock` 이 `setupTests.ts` 의 것보다 우선한다.)
 */
vi.mock("next-intl", async (importOriginal) => await importOriginal<object>());

const messages = { probe: { hello: "안녕" } };

/** 리렌더를 강제하면서 t 의 참조가 바뀌는지 기록한다. */
function Probe({ seen }: { seen: Array<unknown> }) {
  const [n, setN] = useState(0);
  const t = useTranslations("probe");
  seen.push(t);
  return (
    <button onClick={() => setN((v) => v + 1)}>
      {t("hello")}-{n}
    </button>
  );
}

async function measure(): Promise<Array<unknown>> {
  const user = userEvent.setup();
  const seen: Array<unknown> = [];
  render(
    <NextIntlClientProvider locale="ko" messages={messages}>
      <Probe seen={seen} />
    </NextIntlClientProvider>,
  );
  const button = screen.getByRole("button");
  await user.click(button);
  await user.click(button);
  return seen;
}

describe("useTranslations 의 t 참조 안정성", () => {
  it("진짜 next-intl 에서는 리렌더해도 같은 참조다", async () => {
    const seen = await measure();

    // ⚠️ 리렌더가 실제로 일어나야 측정이 성립한다. 안 일어났으면 무엇을 재든 "1종"이
    //    나와서 거짓으로 "안정적" 이라 읽힌다. 그래서 렌더 횟수를 먼저 단언한다.
    expect(seen.length, "리렌더가 안 일어났다 — 이 측정은 무의미하다").toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size, "t 가 매 렌더 새 참조가 됐다 — next-intl 이 동작을 바꿨다").toBe(1);

    // 목이 아니라 진짜 모듈을 쟀다는 증거: 목은 messages 를 무시하고 ko.json 을 쓴다.
    expect(screen.getByRole("button").textContent).toContain("안녕");
  });
});

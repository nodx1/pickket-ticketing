/**
 * 🔴 **테스트 전역 목의 `t` 는 매 렌더 새 참조다.** 그 사실을 고정한다.
 *
 * 짝 문서: [`use-translations-stability.test.tsx`](./use-translations-stability.test.tsx)
 * — 그쪽은 목을 끄고 **진짜 next-intl** 을 재고, 여기는 **목이 켜진 채로** 잰다.
 * 두 답이 다르다는 것이 요점이다.
 *
 * ```
 * 진짜 next-intl (4.8.3)   안정 참조     ← 프로덕션 동작
 * setupTests.ts:37 의 목    매번 새 함수  ← 테스트 동작
 * ```
 *
 * ## 왜 이게 중요한가
 * `useCallback(..., [t])` 같은 코드는 **테스트에서만** 콜백을 매 렌더 새로 만든다.
 * 그 콜백이 `useEffect` deps 이면 테스트에서 무한 루프가 나는데 프로덕션은 멀쩡하다
 * (반대로, 테스트가 통과했다고 프로덕션 안전이 증명되는 것도 아니다).
 *
 * ⟹ **deps 안전성은 이 테스트 환경으로 판정하지 말 것.**
 *
 * 이 파일은 일부러 `vi.mock("next-intl")` 을 두지 않는다 — 전역 목을 그대로 쓴다.
 */
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function Probe({ seen }: { seen: Array<unknown> }) {
  const [n, setN] = useState(0);
  const t = useTranslations("common");
  seen.push(t);
  return <button onClick={() => setN((v) => v + 1)}>tick-{n}</button>;
}

describe("전역 next-intl 목", () => {
  it("🔴 리렌더마다 t 가 새 참조다 — 목이 안정화되면 이 테스트가 알려준다", async () => {
    const user = userEvent.setup();
    const seen: Array<unknown> = [];
    render(<Probe seen={seen} />);

    const button = screen.getByRole("button");
    await user.click(button);
    await user.click(button);

    expect(seen.length, "리렌더가 안 일어났다 — 측정 무의미").toBeGreaterThanOrEqual(3);
    expect(
      new Set(seen).size,
      "목이 t 를 안정화했다 — use-translations-stability.test.tsx 의 경고문을 갱신하라",
    ).toBe(seen.length);
  });

  it("컨텍스트(Provider) 없이도 렌더된다 — 목이 하는 일이 그것이다", () => {
    render(<Probe seen={[]} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

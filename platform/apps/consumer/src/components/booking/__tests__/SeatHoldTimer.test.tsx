/**
 * 🔴 좌석 홀드 타이머 — **구매 경로**다. 리렌더에도 카운트다운이 끊기지 않아야 한다.
 *
 * ## 왜 이 테스트가 생겼나
 * React Compiler 가 `handleExpire` 의 수동 memo 를 못 지킨다고 막고 있었다. 시키는 대로
 * deps 에 `t` 를 넣으면 고쳐지지만, `handleExpire` 는 1초 interval effect 의 deps 이기도
 * 하다. 콜백이 매 렌더 새 참조가 되면 **interval 이 매 렌더 정리·재생성되어 1초를 못
 * 채운다** — 카운트다운이 멈춘 것처럼 보인다.
 *
 * 실측 결과 진짜 next-intl 의 `t` 는 안정 참조라 프로덕션은 무사했겠지만,
 * **테스트 전역 목의 t 는 매 렌더 새 함수**다(`use-translations-mock-instability.test.tsx`).
 * 구매 경로라 환경에 안 기대는 쪽 — 번역을 렌더 시점 문자열로 뽑는 방식 — 을 택했고
 * 이 테스트가 그 선택을 고정한다.
 *
 * ⚠️ `t` 는 `setupTests.ts` 전역 목이 **실제 `messages/ko.json`** 으로 해석한다.
 *    여기서 messages 를 따로 주입해도 무시된다 — 그래서 진짜 문구로 단언한다.
 *    (처음에 직접 만든 messages 로 단언했다가 전부 빗나갔다.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import SeatHoldTimer from "../SeatHoldTimer";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

/** ko.json: `"좌석 홀드: {minutes}:{seconds}"` */
const label = (mm: string, ss: string) => `좌석 홀드: ${mm}:${ss}`;

function renderTimer(secondsLeft: number, onExpire: () => void) {
  const expiresAt = new Date(Date.now() + secondsLeft * 1000).toISOString();
  return render(<SeatHoldTimer holdExpiresAt={expiresAt} onExpire={onExpire} />);
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("좌석 홀드 타이머", () => {
  it("남은 시간을 분:초로 보여준다", () => {
    renderTimer(305, vi.fn());
    // ⚠️ 가짜 타이머라 실시간이 안 흐른다 → 정확히 305초 = 05:05.
    //    (실시간 타이머로 탐침했을 땐 05:04 였다 — 경계값을 실측 없이 쓰지 말 것.)
    expect(screen.getByText(label("05", "05"))).toBeInTheDocument();
  });

  it("🔴 1초마다 줄어든다 — interval 이 살아 있다", () => {
    renderTimer(305, vi.fn());
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByText(label("05", "02")), "카운트다운이 안 흐른다").toBeInTheDocument();
  });

  /**
   * 🔴 이 테스트가 이 파일의 존재 이유다.
   *
   * 부모가 1초 안에 여러 번 리렌더해도 interval 이 재생성되지 않아야 한다.
   * `handleExpire` 의 deps 에 렌더마다 바뀌는 값이 들어가면 여기서 죽는다.
   */
  it("🔴 리렌더를 반복해도 카운트다운이 계속 흐른다", () => {
    const onExpire = vi.fn();
    const expiresAt = new Date(Date.now() + 305 * 1000).toISOString();
    const ui = <SeatHoldTimer holdExpiresAt={expiresAt} onExpire={onExpire} />;
    const { rerender } = render(ui);

    // ⚠️ **먼저 시작값이 실제로 그려지는지 본다.** 이걸 안 하면 아래 "없다" 단언이
    //    헛통과한다 — 문구가 애초에 안 그려져도 통과해 버린다(실제로 그랬다).
    expect(screen.getByText(label("05", "05")), "시작 화면부터 안 그려진다").toBeInTheDocument();

    // 900ms 마다 리렌더 — interval 이 매번 재생성되면 1초를 영영 못 채운다.
    for (let i = 0; i < 5; i += 1) {
      act(() => void vi.advanceTimersByTime(900));
      rerender(ui);
    }

    // ⚠️ 화면은 interval 틱에서만 갱신된다 — 4.5초 시점의 마지막 틱은 4초다.
    //    그래서 300초(05:00)가 아니라 **301초(05:01)** 다. 산수로 때려맞히지 말 것.
    expect(
      screen.queryByText(label("05", "05")),
      "4.5초가 지났는데 처음 값 그대로다 — interval 이 매 렌더 재생성되고 있다",
    ).not.toBeInTheDocument();
    expect(screen.getByText(label("05", "01"))).toBeInTheDocument();
  });

  it("🔴 만료되면 onExpire 를 **한 번만** 부른다", () => {
    const onExpire = vi.fn();
    renderTimer(2, onExpire);
    act(() => void vi.advanceTimersByTime(5000));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("만료 후에는 아무것도 그리지 않는다", () => {
    renderTimer(1, vi.fn());
    expect(screen.getByText(/좌석 홀드:/), "만료 전 도달 확인").toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.queryByText(/좌석 홀드:/)).not.toBeInTheDocument();
  });
});

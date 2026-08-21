"use client";

import { useCallback, useRef, useState } from "react";
import { showError } from "@/lib/hooks/useToast";

/**
 * 확인창의 "확인" 동작을 **한 번만** 실행하고, 진행 상태와 실패 표시를 함께 책임진다.
 *
 * ── 왜 훅으로 모으나 (2026-07-30, S3) ──
 * `ConfirmDialog` 에 `pending` 을 안 넘긴 화면이 22곳이었다. 그런데 열어보니 "플래그를 안
 * 넘긴 것"이 아니라 **애초에 진행 상태가 없었다.** 게다가 21개 액션 중 **11개**는 호출하는
 * 핸들러에 `catch` 가 없다 — `!response.ok` 는 처리하지만 **fetch 자체의 거부**
 * (네트워크 단절·중단)는 처리하지 않는다.
 *
 * ── 그 경로가 왜 위험한가 (S3 1차 구현의 실제 구멍) ──
 * 처음엔 `void runGuarded(...)` 로 두었다. 그러면 이렇게 된다:
 *   핸들러 throw → finally 가 pending 을 푼다 → **거부된 프로미스가 버려진다**
 *   ⟹ 토스트도 없고 정리 코드(`setDeletingId(null)`)도 안 돈다.
 *      화면은 아무 말이 없는데 pending 은 풀려 있어 사용자가 다시 누른다.
 *      HTTP 500 은 토스트가 뜨는데 네트워크 단절은 무음이라, **실패마다 반응이 다르다.**
 * 재진입 가드는 **in-flight 중복**만 막는다. 이 경로는 막지 못한다.
 *
 * ── 그래서 호출부 11곳에 catch 를 더하지 않고 여기서 막는다 ──
 * 한 곳이라도 빠뜨리면 무음이 되고, **빠뜨려도 모든 게이트가 초록이다**(실제로 그랬다).
 * 다이얼로그 로케이터와 같은 결론이다 — 이식을 기억하는 대신 **빠뜨릴 자리를 없앤다.**
 * 호출부에 이미 `catch` 가 있으면 거기서 끝나므로 이 기본 동작은 발동하지 않는다.
 *
 * 훅이 주는 것 넷:
 *   ① 재진입 차단 — 응답이 느릴 때 여러 번 눌려도 요청은 한 번만
 *   ② 진행 표시 — `pending` 을 그대로 `ConfirmDialog` 에
 *   ③ 확실한 해제 — 던져도 `finally` 에서 푼다
 *   ④ **실패 표시** — 삼켜지지 않는다. 기본 문구가 뜨고, `onError` 로 바꿀 수 있다
 *
 * ⚠️ 흔한 함정 — 화면들이 갖고 있던 `deletingId`·`removingId`·`deleting` 은 "**어떤 항목을**
 *    확인 중인가"(대상 선택)이지 "**지금 요청이 도는가**"가 아니다. 그걸 `pending` 으로
 *    넘기면 창이 열리자마자 확인 버튼이 잠겨 아무것도 못 한다.
 */

export const CONFIRM_ACTION_FALLBACK_MESSAGE =
  "처리 중 문제가 발생했습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요.";

/**
 * 재진입을 막고 진행 상태를 토글하며 `action` 을 실행한다. **거부를 밖으로 흘리지 않는다.**
 *
 * 오류 처리를 훅이 아니라 여기서 하는 이유: vitest 환경이 `node` 라 훅은 단위 검사가
 * 불가능하다. 판정·오류 경로를 전부 이 함수에 두면 전부 검사할 수 있다.
 *
 * @param isRunning 실행 중인지 읽는다(ref 등 렌더와 무관한 저장소여야 한다 —
 *                  `useState` 는 같은 tick 안의 연타를 못 막는다).
 * @returns 성공적으로 끝났으면 `true`. 재진입으로 건너뛰었거나 실패했으면 `false`.
 *
 * ⚠️ **재진입과 실패가 둘 다 `false` 다.** 지금은 반환값을 보는 호출부가 없고, "실패하면
 *    창을 닫지 않는다"는 결정에는 둘 다 `false` 인 게 오히려 맞다. 다만 나중에
 *    `if (await runGuarded(...)) close()` 같은 분기를 붙이려면 **두 경우를 구분해야 한다**
 *    (중복 클릭으로 건너뛴 것은 실패가 아니다). 그때는 반환형을 나눌 것.
 */
export async function runGuarded(
  action: () => Promise<void> | void,
  isRunning: () => boolean,
  setRunning: (v: boolean) => void,
  onError: (err: unknown) => void,
): Promise<boolean> {
  if (isRunning()) return false;
  setRunning(true);
  try {
    await action();
    return true;
  } catch (err: unknown) {
    // 🔴 삼키지 않는다. 여기서 안 알리면 사용자는 "아무 일도 안 일어난 화면"을 본다.
    onError(err);
    return false;
  } finally {
    // 🔴 throw 해도 반드시 푼다. 안 풀면 확인창이 잠긴 채 남아 창을 닫지도 못한다.
    setRunning(false);
  }
}

export interface ConfirmAction {
  /** `ConfirmDialog` 의 `pending` 에 그대로 넘긴다. */
  pending: boolean;
  /** `ConfirmDialog` 의 `onConfirm` 에 그대로 넘긴다. */
  run: () => void;
}

export interface UseConfirmActionOptions {
  /**
   * 실패 시 처리. 미지정이면 기본 문구를 토스트로 띄운다.
   *
   * 호출부가 자기 `catch` 로 더 정확한 문구를 이미 띄우고 있다면 여기까지 오지 않는다 —
   * 그 경우 이 옵션은 필요 없다.
   */
  onError?: (err: unknown) => void;
}

export function useConfirmAction(
  action: () => Promise<void> | void,
  options?: UseConfirmActionOptions,
): ConfirmAction {
  const [pending, setPending] = useState(false);
  // ⚠️ ref 로 잠근다. `pending` state 만 보면 같은 tick 안의 두 번째 클릭이 옛 값을 읽어 통과한다.
  const running = useRef(false);
  const onError = options?.onError;

  const run = useCallback(() => {
    void runGuarded(
      action,
      () => running.current,
      (v) => {
        running.current = v;
        setPending(v);
      },
      (err) => {
        if (onError) {
          onError(err);
          return;
        }
        // 원인은 콘솔/Sentry 로 남기고, 사용자에겐 행동 가능한 문구만 보여준다.
        // (`Failed to fetch` 같은 원문을 한국어 UI 에 그대로 띄우지 않는다)
        console.error("[useConfirmAction] 확인 동작 실패", err);
        showError(CONFIRM_ACTION_FALLBACK_MESSAGE);
      },
    );
  }, [action, onError]);

  return { pending, run };
}

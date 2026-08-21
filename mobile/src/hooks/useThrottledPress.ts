/**
 * 더블탭 방지 훅 — 결제/구매 등 중복 실행 방지
 *
 * 사용법: const onPress = useThrottledPress(() => handlePurchase(), 1000);
 */
import { useRef, useCallback } from "react";

export function useThrottledPress(
  callback: () => void | Promise<void>,
  delayMs = 1000,
) {
  const lastPress = useRef(0);

  return useCallback(() => {
    const now = Date.now();
    if (now - lastPress.current < delayMs) return;
    lastPress.current = now;
    callback();
  }, [callback, delayMs]);
}

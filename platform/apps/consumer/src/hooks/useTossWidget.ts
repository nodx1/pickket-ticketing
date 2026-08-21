"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  renderTossWidget,
  isTossLive,
  type TossWidgetHandle,
} from "@/lib/toss";

/** 결제위젯 컨테이너 selector (한 번에 하나의 결제 UI 만 열리는 것을 전제). */
export const TOSS_WIDGET_METHODS_ID = "toss-widget-methods";
export const TOSS_WIDGET_AGREEMENT_ID = "toss-widget-agreement";

/**
 * 결제위젯 렌더 라이프사이클 훅.
 * active(모달 열림 등) && 라이브 && amount>0 일 때 `#toss-widget-methods`/`#toss-widget-agreement`
 * 컨테이너에 위젯을 렌더하고 핸들(widgetRef)을 보관한다. 결제요청은 호출측에서 widgetRef 로.
 */
export function useTossWidget(amount: number, active: boolean) {
  const widgetRef = useRef<TossWidgetHandle | null>(null);
  const [ready, setReady] = useState(false);
  // 렌더 실패 여부 — "로딩 중(ready=false, error=false)"과 "실패(error=true)"를 구분해
  // 무한 로딩 대신 재시도 UI 를 노출할 수 있게 한다.
  const [error, setError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  /** 위젯 렌더 재시도(로드 실패 시 사용). */
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active || !isTossLive() || amount <= 0) {
      widgetRef.current = null;
      setReady(false);
      setError(false);
      return;
    }
    let cancelled = false;
    setReady(false);
    setError(false);
    (async () => {
      try {
        const handle = await renderTossWidget({
          amount,
          methodsSelector: `#${TOSS_WIDGET_METHODS_ID}`,
          agreementSelector: `#${TOSS_WIDGET_AGREEMENT_ID}`,
        });
        if (!cancelled) {
          widgetRef.current = handle;
          setReady(true);
        }
      } catch {
        if (!cancelled) {
          widgetRef.current = null;
          setError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // amount 변동은 아래 setAmount effect 로 반영(여기 deps 에 넣으면 위젯 중복 렌더).
    // reloadNonce 변경 시 재렌더(재시도).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reloadNonce]);

  useEffect(() => {
    if (widgetRef.current) void widgetRef.current.setAmount(amount);
  }, [amount]);

  return { widgetRef, ready, error, reload };
}

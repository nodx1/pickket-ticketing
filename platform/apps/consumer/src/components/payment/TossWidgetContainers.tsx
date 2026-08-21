"use client";

import { isTossLive } from "@/lib/toss";
import {
  TOSS_WIDGET_METHODS_ID,
  TOSS_WIDGET_AGREEMENT_ID,
} from "@/hooks/useTossWidget";

/**
 * 토스 결제위젯 렌더 컨테이너. useTossWidget 이 이 selector 로 결제수단/약관 위젯을 렌더한다.
 * 결제 UI(모달 등)에서 결제수단 선택 자리에 배치한다.
 *
 * clientKey 미설정(데모/로컬)에서는 위젯이 렌더되지 않으므로 데모 안내를 보여준다.
 */
export function TossWidgetContainers({ ready }: { ready?: boolean }) {
  const live = isTossLive();

  if (!live) {
    return (
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-xs text-muted-foreground">
        데모 모드 — 실제 결제 없이 예약이 완료됩니다(토스 키 미설정).
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div id={TOSS_WIDGET_METHODS_ID} />
      <div id={TOSS_WIDGET_AGREEMENT_ID} />
      {ready === false ? (
        <p className="text-xs text-muted-foreground">결제 수단을 불러오는 중…</p>
      ) : null}
    </div>
  );
}

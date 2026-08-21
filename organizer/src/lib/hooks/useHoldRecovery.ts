"use client";

/**
 * P0-U1 + P0-U4 — 페이지 진입 시 저장된 좌석 홀드 복원.
 *
 * 사용 예:
 *   const { recoveredHold, dismiss } = useHoldRecovery(eventSlug);
 *   if (recoveredHold) showRestoreDialog(recoveredHold, dismiss);
 */

import { useState, useSyncExternalStore } from "react";
import { loadHold, clearHold, type StoredHold } from "@/lib/seats/hold-storage";

const noop = () => () => {};

export function useHoldRecovery(eventSlug: string) {
  // localStorage 동기 읽기 → 외부 store 패턴으로 effect 우회 (React 19 권장)
  const stored = useSyncExternalStore<StoredHold | null>(
    noop,
    () => loadHold(eventSlug),
    () => null,
  );
  const [dismissed, setDismissed] = useState(false);
  const recoveredHold = dismissed ? null : stored;

  const dismiss = () => {
    clearHold();
    setDismissed(true);
  };

  return { recoveredHold, dismiss };
}

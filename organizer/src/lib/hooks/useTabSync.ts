"use client";

/**
 * P0-U3 — 다른 탭에서 좌석 홀드 이벤트가 발생하면 핸들러 실행.
 */

import { useEffect } from "react";
import {
  subscribeToHoldChanges,
  type TabMessage,
} from "@/lib/seats/tab-sync";

export function useTabSync(handler: (msg: TabMessage) => void) {
  useEffect(() => {
    return subscribeToHoldChanges(handler);
  }, [handler]);
}

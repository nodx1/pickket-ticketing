"use client";

import { useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { EVENT_STATUS_LABELS } from "@/lib/constants";
import type { EventStatus } from "@/lib/types";

interface StatusBadgeProps {
  status: EventStatus;
  /** 이벤트 종료 시각 — 지났으면 상태와 무관하게 "종료" 로 표시 */
  endsAt?: string | Date | null;
}

const statusVariantMap: Record<EventStatus, "secondary" | "success" | "warning" | "outline" | "info" | "destructive"> = {
  draft: "secondary",
  pending_review: "info",
  rejected: "destructive",
  live: "success",
  paused: "warning",
  archived: "outline",
};

// 라벨 단일 진실원(SoT): constants 의 EVENT_STATUS_LABELS 재사용(파편 방지).
const statusLabelMap: Record<EventStatus, string> = EVENT_STATUS_LABELS;

export function StatusBadge({ status, endsAt }: StatusBadgeProps) {
  const endsAtMs =
    endsAt && (status === "live" || status === "paused")
      ? new Date(endsAt).getTime()
      : null;

  // "종료 시각 경과" 판정. render 본문에서 Date.now()(비순수) 호출을 피하려고
  // useSyncExternalStore 의 getSnapshot(외부 소스 읽기 콜백) 안에서 시각을 읽어 boolean 만 반환.
  // 서버 스냅샷은 항상 false → SSR/CSR 하이드레이션 불일치 방지. 경과 시점에 한 번 재렌더(setTimeout).
  const isEnded = useSyncExternalStore(
    (onChange) => {
      if (endsAtMs == null) return () => {};
      const remaining = endsAtMs - Date.now();
      if (remaining <= 0) return () => {};
      const id = setTimeout(onChange, remaining);
      return () => clearTimeout(id);
    },
    () => endsAtMs != null && Date.now() >= endsAtMs,
    () => false,
  );

  if (isEnded) {
    return <Badge variant="outline">종료</Badge>;
  }
  return <Badge variant={statusVariantMap[status]}>{statusLabelMap[status]}</Badge>;
}

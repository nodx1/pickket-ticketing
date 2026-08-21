"use client";

import { Info } from "lucide-react";

/**
 * 상세페이지 통합 트랙B U3 — 이벤트별 동적 컨텍스트 배너.
 * go 원본(context-banner.tsx) 이식. EventResponse.context_banner 필드를 사용한다.
 * 값이 없으면(NULL/빈문자열) 미노출. 문구는 plain text 로 렌더(HTML 주입 없음 → sanitize 불필요).
 */
export function EventContextBanner({ banner }: { banner?: string | null }) {
  const text = banner?.trim();
  if (!text) return null;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 pt-4">
      <div className="flex items-center gap-2.5 rounded-2xl bg-primary/10 px-4 py-3 text-center text-sm font-medium text-foreground">
        <Info className="size-4 shrink-0 text-primary" />
        <span className="flex-1 text-left leading-relaxed">{text}</span>
      </div>
    </div>
  );
}

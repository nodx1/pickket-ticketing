"use client";

import { useTranslations } from "next-intl";
import { RotateCcw } from "lucide-react";
import { CollapsibleCard } from "./CollapsibleCard";
import { feeScheduleRows } from "./cancellationSchedule";

interface CancellationFeeTier {
  days_before: number;
  fee_pct: number;
}

/**
 * 취소·환불 수수료 일정 카드.
 * go 주최자가 설정한 이벤트별 취소정책(v2 cancellation_fee_tiers)을 소비자 상세에 노출.
 * 정책 없음(빈배열/누락) 시 렌더하지 않음 — 상단 공통 /refund-policy 가 기본 안내.
 */
export function CancellationPolicyCard({
  tiers,
}: {
  tiers?: CancellationFeeTier[] | null;
}) {
  const t = useTranslations("event.cancellationPolicy");
  if (!tiers || tiers.length === 0) return null;

  // 서버 환불 계산과 같은 구간으로 풀어 쓴다(cancellationSchedule.ts). 먼 시점 → 임박 순.
  const rows = feeScheduleRows(tiers);
  const when = (from: number | null, to: number) =>
    from === null
      ? t("beforeDays", { days: to })
      : from === 0
        ? t("sameDay")
        : from === to
          ? t("dDay", { days: to })
          : t("rangeDays", { from, to });
  return (
    <CollapsibleCard title={t("title")} icon={RotateCcw} span="full" defaultOpen>
      <div className="divide-y divide-border">
        {rows.map((r, i) => (
          <div key={`${r.from}-${r.to}-${i}`} className="flex items-center justify-between py-3 text-sm">
            <span className="text-muted-foreground">{when(r.from, r.to)}</span>
            <span
              className={
                r.feePct === 0
                  ? "font-semibold text-emerald-600 dark:text-emerald-400"
                  : "font-semibold text-foreground"
              }
            >
              {r.feePct === 0 ? t("freeCancel") : t("feePct", { pct: r.feePct })}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t("note")}</p>
    </CollapsibleCard>
  );
}

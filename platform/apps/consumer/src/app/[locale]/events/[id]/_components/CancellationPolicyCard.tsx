"use client";

import { useTranslations } from "next-intl";
import { RotateCcw } from "lucide-react";
import { CollapsibleCard } from "./CollapsibleCard";

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

  // 공연에서 먼 시점 → 임박 순(days_before 내림차순)으로 정렬해 표시.
  const sorted = [...tiers].sort((a, b) => b.days_before - a.days_before);

  return (
    <CollapsibleCard title={t("title")} icon={RotateCcw} span="full" defaultOpen>
      <div className="divide-y divide-border">
        {sorted.map((tier, i) => (
          <div
            key={`${tier.days_before}-${i}`}
            className="flex items-center justify-between py-3 text-sm"
          >
            <span className="text-muted-foreground">
              {tier.days_before > 0
                ? t("upToDays", { days: tier.days_before })
                : t("sameDay")}
            </span>
            <span
              className={
                tier.fee_pct === 0
                  ? "font-semibold text-emerald-600 dark:text-emerald-400"
                  : "font-semibold text-foreground"
              }
            >
              {tier.fee_pct === 0 ? t("freeCancel") : `${tier.fee_pct}%`}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t("note")}</p>
    </CollapsibleCard>
  );
}

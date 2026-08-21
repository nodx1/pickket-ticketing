"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Sparkles, Clock, Users, ArrowRight } from "lucide-react";
import type { SeatTier, VenueSectionData } from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";
import MyLotteryResultCard from "./MyLotteryResultCard";

interface Props {
  eventId: string;
  locale: string;
  eventTitle: string;
  tiers: SeatTier[];
  sections: VenueSectionData[];
  /** 구역별 응모자 수 (sectionName → entryCount). 폴링으로 갱신됨. */
  entryCountsByTier: Record<string, number>;
  /** 내가 응모한 항목 (있으면 현황 표시). */
  myEntry?: {
    tierId: string;
    tierName: string;
    sectionName: string;
    groupSize: number;
    investedAp: number;
  } | null;
  closesAt?: string | null;
  /** 응모 완료 시 증가 → MyLotteryResultCard 즉시 재조회 */
  refreshKey?: number;
  onOpenApplyModal: (args: { tier: SeatTier; sectionName: string }) => void;
}

export default function LotteryApplyPanel({
  eventId,
  locale,
  eventTitle: _eventTitle,
  tiers,
  sections,
  entryCountsByTier,
  myEntry,
  closesAt,
  refreshKey,
  onOpenApplyModal,
}: Props) {
  const t = useTranslations("booking.lotteryApplyPanel");
  /* 구역 → tier 매핑: section.name 첫 문자가 tier.name 과 매칭되거나 section.color 로 매칭.
   * 현재 pickket-go 는 구역 1개 = tier 1개 1:1 매핑 전제. 가장 단순하게 sections 순서와
   * tiers 순서로 zipping 하되, 이름 기반 매칭을 우선. */
  const sectionTierMap = useMemo(() => {
    const map = new Map<string, SeatTier>();
    const assigned = sections.filter((s) => (s.kind ?? "assigned") !== "stage");
    // name 기반 매칭 시도
    assigned.forEach((s, idx) => {
      const byName = tiers.find((t) => t.name === s.name);
      map.set(s.name, byName ?? tiers[idx] ?? tiers[0]);
    });
    return map;
  }, [sections, tiers]);

  const applicableSections = sections.filter(
    (s) => (s.kind ?? "assigned") !== "stage",
  );

  return (
    <div className="w-full lg:w-[420px] shrink-0 flex flex-col border-l-0 lg:border-l border-border bg-background overflow-y-auto">
      {/* 헤더 — 추첨 안내 */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            {t("title")}
          </h2>
        </div>
        {closesAt && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>
              {t("closesAtLabel")}{" "}
              {new Date(closesAt).toLocaleString("ko-KR", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}
      </div>

      {/* 내 추첨 결과/응모 현황 카드 (서버에서 실제 상태 조회, 당첨 시 결제 CTA 포함) */}
      <MyLotteryResultCard
        eventId={eventId}
        locale={locale}
        refreshKey={refreshKey}
      />

      {/* 구역 목록 */}
      <div className="p-6 flex flex-col gap-3">
        <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
          {t("sectionSelectLabel")}
        </div>
        {applicableSections.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            {t("noSections")}
          </div>
        )}
        {applicableSections.map((section) => {
          const tier = sectionTierMap.get(section.name);
          if (!tier) return null;
          const price = tier.face_price || tier.base_price;
          const entryCount = entryCountsByTier[tier.id] ?? 0;
          const capacity = section.capacity || tier.capacity || 0;
          const ratio = capacity > 0 ? (entryCount / capacity).toFixed(2) : "-";
          const isMine = myEntry?.tierId === tier.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() =>
                onOpenApplyModal({ tier, sectionName: section.name })
              }
              aria-label={t("sectionAriaLabel", { sectionLabel: (section.label || section.name) ?? "", price: formatKRW(price), entryCount: entryCount ?? 0 })}
              className="flex items-center justify-between p-4 rounded-lg border border-border hover:border-primary/50 hover:bg-muted/30 transition-colors text-left w-full"
              style={{
                borderColor: isMine ? section.color : undefined,
                backgroundColor: isMine ? `${section.color}10` : undefined,
              }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: section.color }}
                />
                <div>
                  <div className="font-bold text-sm text-foreground">
                    {t("sectionName", { sectionLabel: (section.label || section.name) ?? "" })}
                  </div>
                  <div className="flex items-center gap-1 text-2xs text-muted-foreground mt-0.5">
                    <Users className="h-3 w-3" />
                    <span>
                      {t("entryStats", { entryCount: entryCount ?? 0, ratio: ratio ?? "-" })}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-right">
                  <div className="font-bold text-sm font-tabular">
                    {formatKRW(price)}
                  </div>
                  <div className="text-2xs text-muted-foreground">
                    {t("capacity", { capacity: capacity ?? 0 })}
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </button>
          );
        })}
      </div>

      {/* 안내 문구 */}
      <div className="p-6 mt-auto border-t border-border text-2xs text-muted-foreground leading-relaxed">
        <p className="mb-1">
          {t("noticeNoPayment")}
        </p>
        <p className="mb-1">{t("noticeRandomSeat")}</p>
        <p>{t("noticeCommitReveal")}</p>
      </div>
    </div>
  );
}

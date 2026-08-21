"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Check, Dice5, Ticket, Eye, Clock, Hourglass } from "lucide-react";
import { useTranslations } from "next-intl";
import type { MyEventStatus } from "@pickket/lib/api";
import { fmt } from "../detail-helpers";
import ContentWidth from "@/components/ui/ContentWidth";

// CTA_CONFIG and PHASE_CTA are now built inside the component using t()

// M월 D일 HH:MM 포맷 (응모 시작일 / 당첨자 발표일) — 같은 날짜 안에서 분 단위까지 구분.
// KST 강제 변환 (SSR=UTC, client=KST 차이로 hydration mismatch 방지).
function formatKoreanDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const utc = new Date(iso);
  const kst = new Date(utc.getTime() + 9 * 60 * 60 * 1000);
  const month = kst.getUTCMonth() + 1;
  const day = kst.getUTCDate();
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${month}월 ${day}일 ${hh}:${mm}`;
}

interface MobileStickyBottomProps {
  tierName: string;
  price: number;
  qty: number;
  onCTAClick: () => void;
  status: string;
  competitionRatio?: number;
  myStatus?: MyEventStatus | null;
  isLottery?: boolean;
  lotteryPhase?: "pre_apply" | "applying" | "closed" | "drawing" | "drawn";
  biddingClosesAt?: string | null;
  biddingOpensAt?: string | null;
  myStatusLoaded?: boolean;
  isSoldOut?: boolean;
  salesPaused?: boolean;
}

export function MobileStickyBottom({
  tierName,
  price,
  qty,
  onCTAClick,
  status,
  competitionRatio,
  myStatus,
  isLottery,
  lotteryPhase,
  biddingClosesAt,
  biddingOpensAt,
  myStatusLoaded: _myStatusLoaded = true,
  isSoldOut = false,
  salesPaused = false,
}: MobileStickyBottomProps) {
  const t = useTranslations("event.mobileStickyBottom");
  const params = useParams();
  const router = useRouter();
  const eventId = params.id as string;
  const total = price * qty;

  const CTA_CONFIG: Record<string, { text: string; icon: typeof Dice5 }> = {
    bidding_open: { text: t("apply"), icon: Dice5 },
    open: { text: t("book"), icon: Ticket },
    allocated: { text: t("viewResult"), icon: Eye },
  };

  // lottery phase 별 CTA 매핑 — phase 는 public lottery-stats 응답
  const PHASE_CTA: Record<
    string,
    { text: string; icon: typeof Dice5; disabled: boolean }
  > = {
    pre_apply: { text: t("applyNotStarted"), icon: Hourglass, disabled: true },
    applying: { text: t("apply"), icon: Dice5, disabled: false },
    closed: { text: t("applyClosed"), icon: Clock, disabled: true },
    drawing: { text: t("drawingInProgress"), icon: Hourglass, disabled: true },
    drawn: { text: t("checkResult"), icon: Eye, disabled: false },
  };

  // CTA 결정:
  // 0) lottery 당첨 + 결제 만료/취소 → "예매하기" 활성 (잔여 fcfs 진입)
  // 1) lottery 이벤트 + 이미 응모 완료 → "응모 마감 M월 D일" 비활성 (applying/closed/drawing)
  //    drawn 이후엔 "결과 확인" 활성
  // 2) lottery 이벤트면 phase 기준 (pre_apply/applying/closed/drawing/drawn)
  // 3) 아니면 event.status 기준
  const wonExpired =
    isLottery &&
    myStatus?.has_lottery_entry &&
    myStatus.lottery_status === "won" &&
    (myStatus.lottery_order_status === "expired" ||
      myStatus.lottery_order_status === "cancelled");
  let cta: { text: string; icon: typeof Dice5; disabled?: boolean };
  if (salesPaused) {
    // 주최자가 판매 일시중지 — status 는 유지되나 예매 차단(최우선). 결제단계 차단 이전에 안내.
    cta = { text: t("salesPaused"), icon: Clock, disabled: true };
  } else if (wonExpired) {
    // 매진이면 잔여석 없으니 비활성
    cta = isSoldOut
      ? { text: t("paymentExpired"), icon: Clock, disabled: true }
      : { text: t("book"), icon: Ticket, disabled: false };
  } else if (
    isLottery &&
    myStatus?.has_lottery_entry &&
    lotteryPhase !== "drawn"
  ) {
    // 응모 완료자 — "당첨자 발표 - M월 D일" 비활성
    const announceDate = formatKoreanDate(biddingClosesAt);
    cta = {
      text: announceDate ? t("announceDate", { date: announceDate }) : t("applyCompleted"),
      icon: Clock,
      disabled: true,
    };
  } else if (isLottery && lotteryPhase === "pre_apply") {
    // 응모 시작 전 — "응모 시작 - M월 D일" 비활성
    const opensDate = formatKoreanDate(biddingOpensAt);
    cta = {
      text: opensDate ? t("applyOpensDate", { date: opensDate }) : t("applyNotStartedShort"),
      icon: Hourglass,
      disabled: true,
    };
  } else if (isLottery && lotteryPhase) {
    cta = PHASE_CTA[lotteryPhase] ?? CTA_CONFIG.bidding_open;
  } else if (status === "bidding_open") {
    cta = { text: t("book"), icon: Ticket };
  } else {
    cta = CTA_CONFIG[status] ?? { text: t("viewDetail"), icon: Eye };
  }
  const Icon = cta.icon;
  const disabled = !!cta.disabled;

  // has_ticket 은 backend에서 이미 PENDING 제외 → 결제 확정된 경우만 true.
  // 당첨 미결제자/미당첨자 모두 CTA 활성화되어 재구매 가능.
  // lottery_entry 존재로는 차단하지 않음 (결과 나온 후 재구매 허용).
  const hasCompleted = myStatus?.has_ticket;

  const ratioColor =
    competitionRatio != null
      ? competitionRatio >= 0.8
        ? "#DC2626"
        : competitionRatio >= 0.5
          ? "hsl(var(--primary))"
          : "#00A882"
      : null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-background/90 backdrop-blur-2xl border-t border-border shadow-[0_-8px_32px_rgba(0,0,0,0.5)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* Mini competition bar */}
      {competitionRatio != null && (
        <div className="h-0.5 w-full bg-border">
          <div
            className="h-full transition-all duration-700"
            style={{
              width: `${Math.min(competitionRatio * 100, 100)}%`,
              backgroundColor: ratioColor ?? undefined,
              boxShadow: `0 0 6px ${ratioColor}`,
            }}
          />
        </div>
      )}
      <ContentWidth className="px-4 py-3.5 flex items-center justify-between gap-3">
        <div>
          <p className="text-lg font-black text-emerald-600 dark:text-emerald-400 font-tabular">
            {t("totalPrice", { amount: fmt(total) })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("tierQtyFee", { tier: tierName, qty })}
          </p>
        </div>
        {hasCompleted ? (
          <Link
            href={
              myStatus?.has_ticket ? "/mypage?tab=tickets" : "/mypage?tab=bids"
            }
            className="flex items-center gap-2 px-7 h-12 rounded-full bg-emerald-600 text-white font-bold text-sm tracking-widest shadow-sm hover:brightness-110 transition-all active:scale-95"
          >
            <Check className="h-4 w-4" />
            {myStatus?.has_ticket ? t("bookingCompleted") : t("applyCompleted")}
          </Link>
        ) : (
          <button
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              // drawn → 결과 확인 → mypage
              if (isLottery && lotteryPhase === "drawn") {
                router.push("/mypage?tab=bids");
                return;
              }
              // allocated → scroll to results
              if (status === "allocated") {
                onCTAClick();
                return;
              }
              // bidding_open → queue/apply flow
              if (status === "bidding_open") {
                onCTAClick();
                return;
              }
              // Default → navigate to booking page
              router.push(`/events/${eventId}/booking`);
            }}
            className={`flex items-center gap-2 px-7 h-12 rounded-full font-bold text-sm uppercase tracking-widest shadow-sm transition-all ${
              disabled
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-white hover:brightness-110 active:scale-95"
            }`}
          >
            <Icon className="h-4 w-4" />
            {cta.text}
          </button>
        )}
      </ContentWidth>
    </div>
  );
}

"use client";

import { useState, useEffect, useContext } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import {
  Dice5,
  Minus,
  Plus,
  Check,
  CheckCircle,
  ChevronDown,
  Shield,
  Clock,
  Ticket,
  Eye,
} from "lucide-react";
import { fmt, useCountdown } from "../detail-helpers";
import { MileageExplainer } from "./MileageExplainer";
import { getEventComments } from "@pickket/lib/api";
import { normalizeSaleMode } from "@pickket/lib";
import { DetailPageContext } from "../detail-context";
import { CARD, BTN } from "@/lib/styles";

const TIER_DOT_COLORS = [
  "bg-violet-500",
  "bg-blue-500",
  "bg-cyan-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
];

const TIER_SELECTED_STYLES = [
  { border: "border-violet-400", bg: "bg-violet-50 dark:bg-violet-900/20" },
  { border: "border-blue-400", bg: "bg-blue-50 dark:bg-blue-900/20" },
  { border: "border-cyan-400", bg: "bg-cyan-50 dark:bg-cyan-900/20" },
  { border: "border-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-900/20" },
  { border: "border-amber-400", bg: "bg-amber-50 dark:bg-amber-900/20" },
  { border: "border-rose-400", bg: "bg-rose-50 dark:bg-rose-900/20" },
];


interface BookingStateInfo {
  selectedSeats: number;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  tierId: string | null;
}

interface BookingSidebarProps {
  event: {
    id: string;
    title: string;
    status: string;
    bid_count?: number;
    total_seats: number;
    bidding_close_date?: string;
    organizer_name?: string;
  };
  tiers: Array<{
    id: string;
    name: string;
    base_price: number;
    face_price?: number;
    remaining: number;
    total: number;
    sale_mode: string;
  }>;
  onCTAClick: () => void;
  onTierChange?: (tierId: string) => void;
  onQtyChange?: (qty: number) => void;
  externalTierId?: string | null;
  bookingStepInfo?: string | null;
  bookingState?: BookingStateInfo | null;
}

export function BookingSidebar({
  event,
  tiers,
  onCTAClick,
  onTierChange,
  onQtyChange,
  externalTierId,
  bookingStepInfo,
  bookingState,
}: BookingSidebarProps) {
  const t = useTranslations("booking.sidebar");

  const CTA_CONFIG: Record<string, { text: string; icon: typeof Dice5 }> = {
    bidding_open: { text: t("ctaLottery"), icon: Dice5 },
    open: { text: t("ctaBook"), icon: Ticket },
    allocated: { text: t("ctaResult"), icon: Eye },
  };

  const [selectedTierIdx, setSelectedTierIdx] = useState(
    tiers.length > 1 ? 1 : 0,
  );
  const [tierOpen, setTierOpen] = useState(false);
  const [qty, setQty] = useState(1);
  const countdown = useCountdown(event.bidding_close_date ?? "");

  // Sync external tier selection (from BookingFlow)
  useEffect(() => {
    if (!externalTierId) return;
    const idx = tiers.findIndex((t) => t.id === externalTierId);
    if (idx < 0) return;
    setSelectedTierIdx((prev) => (prev === idx ? prev : idx));
  }, [externalTierId, tiers]);

  // Sync qty to parent via effect to avoid setState-during-render
  useEffect(() => {
    onQtyChange?.(qty);
  }, [qty, onQtyChange]);

  const tier = tiers[selectedTierIdx] ?? tiers[0];
  // Use BookingFlow state if available, otherwise fallback to local calculation
  const displayPrice = tier ? (tier.face_price ?? tier.base_price) : 0;
  const total = bookingState?.totalPrice ?? displayPrice * qty;

  // Use tier sale_mode to determine CTA when status is bidding_open
  const isLotteryTier = tier
    ? normalizeSaleMode(tier.sale_mode) === "lottery"
    : false;
  const ctaKey =
    event.status === "bidding_open" && !isLotteryTier ? "open" : event.status;
  const cta = CTA_CONFIG[ctaKey] ?? { text: t("ctaView"), icon: Eye };
  const CtaIcon = cta.icon;

  return (
    <div id="booking-sidebar" className="w-full min-w-[360px] space-y-4">
      {/* 예매 카드 */}
      <div className={`${CARD.base} space-y-4`}>
        {/* 마감 카운트다운 */}
        {event.bidding_close_date && (
          <div className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-primary/70" />
            <span className="font-medium text-foreground">
              {t("deadlinePrefix")}{" "}
              <span className="font-tabular text-primary/70">
                {t("countdown", { days: countdown.days ?? 0, hours: countdown.hours ?? 0 })}
              </span>
            </span>
          </div>
        )}

        {/* 좌석 선택 드롭다운 */}
        {tier && (
          <div>
            <button
              onClick={() => setTierOpen(!tierOpen)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-border/60 hover:border-input hover:bg-muted transition-colors"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${TIER_DOT_COLORS[selectedTierIdx % TIER_DOT_COLORS.length]}`}
                />
                <span className="font-medium text-foreground">{tier.name}</span>
                <span className="text-sm text-muted-foreground">
                  {t("priceWon", { price: fmt(tier.face_price ?? tier.base_price) })}
                </span>
              </div>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${tierOpen ? "rotate-180" : ""}`}
              />
            </button>

            <AnimatePresence>
              {tierOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 space-y-1.5">
                    {tiers.map((tier2, idx) => {
                      const isSelected = selectedTierIdx === idx;
                      const dot = TIER_DOT_COLORS[idx % TIER_DOT_COLORS.length];
                      const styles =
                        TIER_SELECTED_STYLES[idx % TIER_SELECTED_STYLES.length];
                      const pct =
                        tier2.total > 0
                          ? Math.round(
                              ((tier2.total - tier2.remaining) / tier2.total) * 100,
                            )
                          : 0;
                      return (
                        <button
                          key={tier2.id}
                          onClick={() => {
                            setSelectedTierIdx(idx);
                            setTierOpen(false);
                            onTierChange?.(tier2.id);
                          }}
                          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-all ${
                            isSelected
                              ? `${styles.bg} border ${styles.border}`
                              : "hover:bg-card"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${dot}`} />
                            <span className="text-sm font-medium text-foreground">
                              {tier2.name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {normalizeSaleMode(tier2.sale_mode) === "lottery"
                                ? t("saleLottery")
                                : t("saleFcfs")}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">
                              {t("priceWon", { price: fmt(tier2.face_price ?? tier2.base_price) })}
                            </span>
                            <span className="text-2xs text-muted-foreground">
                              {pct}%
                            </span>
                            {isSelected && (
                              <CheckCircle className="h-4 w-4 text-primary/70" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* 수량 */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t("quantity")}</span>
          <div className="flex items-center gap-3">
            <motion.button
              whileTap={{ scale: 0.85 }}
              disabled={qty <= 1}
              onClick={() => setQty((prev) => Math.max(1, prev - 1))}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-30"
            >
              <Minus className="h-4 w-4" />
            </motion.button>
            <span className="w-6 text-center text-lg font-bold text-foreground">
              {qty}
            </span>
            <motion.button
              whileTap={{ scale: 0.85 }}
              disabled={qty >= 4}
              onClick={() => setQty((prev) => Math.min(4, prev + 1))}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-foreground disabled:opacity-30"
            >
              <Plus className="h-4 w-4" />
            </motion.button>
          </div>
        </div>

        {/* 합계 */}
        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{t("total")}</span>
            <span className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              {t("priceWon", { price: fmt(total) })}
            </span>
          </div>
          <p className="text-xs-plus text-muted-foreground text-right mt-0.5">
            {t("feeIncluded")}
          </p>
        </div>

        {/* CTA */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={onCTAClick}
          className={`${BTN.ctaFull} uppercase tracking-widest font-black`}
        >
          <CtaIcon className="h-5 w-5" />
          {cta.text}
        </motion.button>

        {/* 예매 진행 상태 */}
        {bookingStepInfo && (
          <div className="text-center text-xs text-muted-foreground py-1">
            {bookingStepInfo}
          </div>
        )}

        {/* 신뢰 배지 */}
        <div className="flex items-center gap-3 pt-1 text-xs-plus text-muted-foreground">
          <span className="flex items-center gap-1">
            <Shield className="h-3 w-3" />
            {t("badgeFairDist")}
          </span>
          <span className="flex items-center gap-1">
            <Check className="h-3 w-3" />
            {t("badgeFacePrice")}
          </span>
          <span className="flex items-center gap-1">
            <Check className="h-3 w-3" />
            {t("badgeSafePayment")}
          </span>
        </div>
      </div>

      {/* 공정 추첨 설명 */}
      <MileageExplainer />

      {/* 주최자 간략 정보 */}
      {event.organizer_name && (
        <div className="rounded-2xl border border-border bg-card shadow-sm p-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-sm font-bold text-muted-foreground">
              {event.organizer_name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-foreground truncate">
                  {event.organizer_name}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{t("organizer")}</p>
            </div>
          </div>
        </div>
      )}

      {/* 커뮤니티 미니 피드 — "지금 대화 중" */}
      <CommunityMiniWidget eventId={event.id} />
    </div>
  );
}

function CommunityMiniWidget({ eventId }: { eventId: string }) {
  const t = useTranslations("booking.sidebar");
  const { setActiveTab } = useContext(DetailPageContext);
  const [comments, setComments] = useState<
    Array<{ user_name: string; content: string }>
  >([]);

  useEffect(() => {
    getEventComments(eventId, { limit: 3, sort: "recent" })
      .then((res) =>
        setComments(
          res.data.items.map((c) => ({
            user_name: c.user_name,
            content: c.content,
          })),
        ),
      )
      .catch(() => {});
  }, [eventId]);

  if (comments.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">
          {t("communityTitle")}
        </span>
        <button
          onClick={() => setActiveTab("community")}
          className="text-xs text-primary/70 hover:underline"
        >
          {t("communityMore")}
        </button>
      </div>
      <div className="space-y-2">
        {comments.map((c, i) => (
          <div key={i} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{c.user_name}</span>{" "}
            {c.content.length > 40 ? c.content.slice(0, 40) + "..." : c.content}
          </div>
        ))}
      </div>
    </div>
  );
}

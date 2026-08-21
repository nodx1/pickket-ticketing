"use client";

import { useState } from "react";
import { useAuthStore } from "@pickket/store";
import {
  applyLottery,
  getPointBalance,
  getTotalPoints,
  getMyEventStatus,
  type EventDetail,
  type SeatTier,
} from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";
import { Button } from "@pickket/ui";
import { toast } from "sonner";
import { Ticket, Info, Copy, Coins, Wallet } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import CountdownTimer from "./CountdownTimer";
import { getOrganizerLabels, getDomainLabels } from "@pickket/lib";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

/* ---------- Constants ---------- */
const AP_MAX_INVEST = 10_000;
const AP_STEP = 100;
const WEIGHT_CAP = 50;

/* ---------- Helpers ---------- */
function getSliderFillColor(pct: number): string {
  if (pct < 33) return "#00A882";
  if (pct < 66) return "hsl(var(--primary))";
  return "#D97706";
}

function getProbColor(pct: number): string {
  if (pct >= 10) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

interface LotteryWidgetProps {
  event: EventDetail;
  tier: SeatTier;
  onAuthRequired?: () => void;
}

export default function LotteryWidget({
  event,
  tier,
  onAuthRequired,
}: LotteryWidgetProps) {
  const orgLabels = getOrganizerLabels(event.category);
  const domainLabels = getDomainLabels(event.category);
  const t = useTranslations("lottery");
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState(1);
  const [applied, setApplied] = useState(false);
  const [confirmationId, setConfirmationId] = useState<string | null>(null);
  const [investedAp, setInvestedAp] = useState(0);

  // Load AP balance
  const { data: apBalance = null } = useQuery<number | null>({
    queryKey: ["user", "apBalance"],
    queryFn: async () => {
      const res = await getPointBalance();
      return res.data ? getTotalPoints(res.data) : 0;
    },
    enabled: !!user,
  });

  // 기존 응모 여부 확인 (쿠키 인증 — user 상태 불필요)
  useQuery({
    queryKey: ["events", event.id, "myLotteryStatus"],
    queryFn: async () => {
      const res = await getMyEventStatus(event.id);
      if (res.data.has_lottery_entry) {
        setApplied(true);
        if (res.data.lottery_entry_id) {
          setConfirmationId(res.data.lottery_entry_id);
        }
      }
      return res.data;
    },
  });

  const apMax =
    apBalance !== null ? Math.min(AP_MAX_INVEST, apBalance) : AP_MAX_INVEST;
  const price = tier.face_price ?? tier.base_price;
  const applicants = event.bid_count || 0;
  const capacity = tier.capacity;
  const competitionRatio =
    capacity > 0 ? Math.max(applicants / capacity, 0) : 0;
  const competitionPct = Math.min(competitionRatio * 100, 100);
  const closingDate = tier.bidding_closes_at || event.bidding_closes_at;

  const effectiveWeight = Math.min(Math.sqrt(investedAp), WEIGHT_CAP);

  // Slider fill track
  const fillPct = apMax > 0 ? (investedAp / apMax) * 100 : 0;
  const fillColor = getSliderFillColor(fillPct);

  // Estimated probability
  const avgWeight = Math.sqrt(500); // ~22.4 median assumption
  const estimatedProb =
    applicants > 0 && capacity > 0 && effectiveWeight > 0
      ? Math.min(
          (effectiveWeight / (avgWeight * applicants)) * capacity * 100,
          100,
        )
      : 0;

  const competitionColor =
    competitionRatio < 1
      ? "text-emerald-600 dark:text-emerald-400"
      : competitionRatio <= 2
        ? "text-primary"
        : "text-red-600 dark:text-red-400";

  const applyMutation = useMutation({
    mutationFn: async () => {
      const clientSeed = crypto.randomUUID();
      return applyLottery(event.id, tier.id, {
        group_size: quantity,
        client_seed: clientSeed,
        invested_ap: investedAp > 0 ? investedAp : undefined,
      });
    },
    onSuccess: (res) => {
      toast.success(
        t("apply_success", { qty: quantity, price: formatKRW(price) }),
      );
      setApplied(true);
      if (res.data?.id) {
        setConfirmationId(res.data.id);
      }
      queryClient.invalidateQueries({
        queryKey: ["events", event.id, "myStatus"],
      });
      queryClient.invalidateQueries({
        queryKey: ["events", event.id, "myLotteryStatus"],
      });
    },
    onError: (err: unknown) => {
      const detail =
        err instanceof Error
          ? err.message
          : (err as { response?: { data?: { detail?: string } } })?.response
              ?.data?.detail || t("apply_fail");
      toast.error(String(detail));
    },
  });

  const submitting = applyMutation.isPending;

  const handleApply = () => {
    if (!user) {
      onAuthRequired?.();
      return;
    }
    applyMutation.mutate();
  };

  const copyConfirmationId = () => {
    if (confirmationId) {
      navigator.clipboard.writeText(confirmationId);
      toast.success(t("confirmation_copied"));
    }
  };

  return (
    <div className="space-y-5">
      {/* Price */}
      <div className="text-center">
        <p className="text-3xl font-bold text-foreground font-tabular">
          {formatKRW(price)}
        </p>
        <div className="inline-block mt-1.5 bg-primary/10 text-primary border border-primary/20 rounded-full px-3 py-0.5 text-xs font-medium">
          공정 추첨
        </div>
        <p className="text-2xs text-muted-foreground/60 mt-1">
          {t("tax_included")}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {t("win_cta", { verb: orgLabels.ctaVerb })}
        </p>
      </div>

      {/* Application stats */}
      <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t("application_status")}
          </span>
          <span className="font-semibold text-foreground">
            {t("current_applicants", { count: applicants, capacity })}
          </span>
        </div>

        <div className="space-y-1">
          <div className="h-3 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary shadow-[0_0_8px_rgba(10,10,10,0.4)] transition-all duration-500"
              style={{ width: `${competitionPct}%` }}
            />
          </div>
          <div className="flex justify-between text-2xs text-muted-foreground/60">
            <span>0</span>
            <span className={competitionColor}>
              {t("competition_ratio", { ratio: competitionRatio.toFixed(1) })}
            </span>
            <span>{t("seats", { count: capacity })}</span>
          </div>
        </div>
      </div>

      {/* Countdown */}
      {closingDate && (
        <CountdownTimer targetDate={closingDate} label={t("deadline_label")} />
      )}

      {/* Quantity selector */}
      <div>
        <p className="text-xs text-muted-foreground mb-2">{t("quantity")}</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={t("qty_decrease")}
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            className="h-9 w-9 rounded-full bg-card hover:bg-muted flex items-center justify-center font-bold text-foreground transition-colors"
          >
            -
          </button>
          <span className="text-lg font-bold text-foreground min-w-[2ch] text-center">
            {quantity}
          </span>
          <button
            type="button"
            aria-label={t("qty_increase")}
            onClick={() =>
              setQuantity((q) => Math.min(tier.max_group_size ?? 4, q + 1))
            }
            className="h-9 w-9 rounded-full bg-card hover:bg-muted flex items-center justify-center font-bold text-foreground transition-colors"
          >
            +
          </button>
          <span className="text-xs text-muted-foreground">
            {t("qty_info", { max: tier.max_group_size ?? 4 })}
          </span>
        </div>
      </div>

      {/* AP Investment (optional) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Coins className="h-4 w-4 text-amber-500" />
            <p className="text-xs font-medium text-foreground">
              {t("ap_invest_title")}
            </p>
          </div>
          {apBalance !== null && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" />
              {t("ap_balance", { balance: apBalance.toLocaleString() })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={apMax}
            step={AP_STEP}
            value={investedAp}
            onChange={(e) => setInvestedAp(Number(e.target.value))}
            style={{
              background: `linear-gradient(to right, ${fillColor} 0%, ${fillColor} ${fillPct}%, rgba(255,255,255,0.1) ${fillPct}%, rgba(255,255,255,0.1) 100%)`,
              transition: "background 0.15s ease",
            }}
            className="flex-1 h-2 rounded-full appearance-none [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:shadow-[0_0_12px_rgba(10,10,10,0.5)] [&::-webkit-slider-thumb]:-mt-1.5 [&::-moz-range-track]:h-2 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary"
          />
          <input
            type="number"
            min={0}
            max={apMax}
            step={AP_STEP}
            value={investedAp}
            onChange={(e) => {
              const v = Math.min(
                apMax,
                Math.max(
                  0,
                  Math.round(Number(e.target.value) / AP_STEP) * AP_STEP,
                ),
              );
              setInvestedAp(v);
            }}
            className="w-20 text-center text-sm font-medium bg-background border border-border text-foreground rounded-lg px-2 py-1"
          />
          <span className="text-xs text-muted-foreground">AP</span>
        </div>
        <div className="bg-card border border-border rounded-xl p-3 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {t("effective_weight")}
            </span>
            <span className="font-semibold text-primary/70">
              +{effectiveWeight.toFixed(1)}
            </span>
          </div>
          {/* Weight visualization */}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-card overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-primary transition-all duration-300"
                style={{
                  width: `${Math.min((effectiveWeight / 50) * 100, 100)}%`,
                }}
              />
            </div>
            <span className="text-2xs text-muted-foreground/60 whitespace-nowrap">
              {effectiveWeight.toFixed(1)} / 50
            </span>
          </div>
          {investedAp > 0 && applicants > 0 && (
            <div className="flex items-center justify-between text-xs mt-2">
              <span className="text-muted-foreground">예상 당첨 확률</span>
              <span className={`font-bold ${getProbColor(estimatedProb)}`}>
                ~{estimatedProb.toFixed(1)}%
              </span>
            </div>
          )}
          {investedAp > 0 && (
            <p className="text-2xs text-muted-foreground/60 mt-1">
              실제 결과는 다를 수 있습니다
            </p>
          )}
          {investedAp === 0 && (
            <p className="text-2xs text-muted-foreground/60">
              {t("no_invest_hint")}
            </p>
          )}
          {quantity >= 2 && (
            <div className="bg-amber-600/5 text-amber-600 dark:text-amber-400 border border-amber-600/10 rounded-lg px-3 py-1.5 text-2xs">
              {t(
                quantity === 2
                  ? "group_discount_2"
                  : quantity === 3
                    ? "group_discount_3"
                    : "group_discount_4",
              )}
            </div>
          )}
        </div>
      </div>

      {/* CTA / Applied state */}
      <AnimatePresence mode="wait">
        {applied ? (
          <motion.div
            key="applied"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-emerald-600/10 border border-emerald-600/20 rounded-2xl p-5 text-center space-y-3"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            >
              <Ticket className="h-10 w-10 text-emerald-600 dark:text-emerald-400 mx-auto" />
            </motion.div>
            <p className="font-bold text-emerald-600 dark:text-emerald-400">{t("applied_title")}</p>
            <p className="text-sm text-muted-foreground">{t("applied_wait")}</p>
            {confirmationId && (
              <div className="space-y-2">
                <div className="font-mono bg-background px-3 py-2 rounded-lg border border-border text-foreground text-xs">
                  {confirmationId}
                </div>
                <button
                  onClick={copyConfirmationId}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-600/10 transition-colors"
                >
                  <Copy className="h-3 w-3" />
                  {t("confirmation_label", { id: "" })}
                </button>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div key="cta" exit={{ opacity: 0 }}>
            <Button
              type="button"
              onClick={handleApply}
              disabled={submitting}
              className="w-full rounded-full bg-gradient-to-r from-primary to-[#404040] text-white font-bold shadow-[0_8px_32px_rgba(10,10,10,0.4)] hover:brightness-110 h-12 text-base"
            >
              {submitting
                ? t("submitting")
                : !user
                  ? t("login_first")
                  : t("apply_cta")}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Info note */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground bg-card border border-border rounded-2xl p-3">
        <Info className="h-4 w-4 shrink-0 mt-0.5" />
        <p>{t("fairness_info", { member: domainLabels.memberLabel })}</p>
      </div>
    </div>
  );
}

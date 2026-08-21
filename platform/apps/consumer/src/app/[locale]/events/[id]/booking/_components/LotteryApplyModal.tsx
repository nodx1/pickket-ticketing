"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Sparkles, Coins } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SeatTier } from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";

interface Props {
  open: boolean;
  tier: SeatTier | null;
  sectionName: string;
  currentEntryCount: number;
  capacity: number;
  onClose: () => void;
  onSubmit: (args: { groupSize: number; investedAp: number }) => Promise<void>;
}

export default function LotteryApplyModal({
  open,
  tier,
  sectionName,
  currentEntryCount,
  capacity,
  onClose,
  onSubmit,
}: Props) {
  const t = useTranslations("booking.lotteryApplyModal");
  const [groupSize, setGroupSize] = useState(1);
  const [investedAp, setInvestedAp] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setGroupSize(1);
      setInvestedAp(0);
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, submitting, onClose]);

  if (!open || !tier || typeof window === "undefined") return null;

  const price = tier.face_price || tier.base_price;
  const _maxGroup = tier.max_group_size ?? 4;
  const ratio =
    capacity > 0 ? ((currentEntryCount + 1) / capacity).toFixed(2) : "-";

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({ groupSize, investedAp });
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(0,0,0,0.5)",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md bg-background border border-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="font-bold text-sm">{t("title", { sectionName: sectionName ?? "" })}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="p-1 hover:bg-muted rounded"
            aria-label={t("close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 구역 정보 */}
        <div className="p-5 space-y-3 border-b border-border">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("priceOnWin")}</span>
            <span className="font-bold font-tabular">{formatKRW(price)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("capacity")}</span>
            <span>{t("capacityCount", { count: capacity ?? 0 })}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("currentEntries")}</span>
            <span>
              {t("entryStats", { count: currentEntryCount ?? 0, ratio: ratio ?? "-" })}
            </span>
          </div>
        </div>

        {/* 매수 — 1매 고정 */}
        <div className="p-5 border-b border-border flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{t("ticketCount")}</span>
          <span className="text-sm font-bold">{t("oneTicket")}</span>
        </div>

        {/* AP 투자 (선택) */}
        <div className="p-5 border-b border-border">
          <div className="flex items-center justify-between mb-3">
            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              {t("apInvestLabel")}
            </label>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Coins className="h-3 w-3" />
              <span>{t("apInvestHint")}</span>
            </div>
          </div>
          {/* 프리셋 버튼 */}
          <div className="flex gap-2 flex-wrap mb-4">
            {[0, 100, 500, 1000, 2500].map((ap) => (
              <button
                key={ap}
                type="button"
                onClick={() => setInvestedAp(ap)}
                className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
                  investedAp === ap
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-muted"
                }`}
              >
                {ap === 0 ? t("none") : `${ap.toLocaleString()} AP`}
              </button>
            ))}
          </div>
          {/* 슬라이더 — 10 AP 단위 */}
          <div className="space-y-2">
            <input
              type="range"
              min={0}
              max={2500}
              step={100}
              value={investedAp}
              onChange={(e) => setInvestedAp(Number(e.target.value))}
              className="w-full accent-primary h-2 rounded-lg cursor-pointer"
            />
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">0 AP</span>
              <span className="font-bold text-primary font-tabular">
                {investedAp.toLocaleString()} AP
              </span>
              <span className="text-muted-foreground">2,500 AP</span>
            </div>
          </div>
          <p className="text-2xs text-muted-foreground mt-3 leading-relaxed">
            {t("apInvestNote")}
          </p>
        </div>

        {/* 응모 버튼 */}
        <div className="p-5">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full py-3 rounded-lg bg-primary text-white font-bold hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {submitting
              ? t("submitting")
              : investedAp > 0
                ? t("submitWithAp", { ap: investedAp ?? 0 })
                : t("submit")}
          </button>
          <p className="text-2xs text-muted-foreground text-center mt-2">
            {t("submitDisclaimer")}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

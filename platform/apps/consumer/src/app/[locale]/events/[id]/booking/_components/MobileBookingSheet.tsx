"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Minus, Plus, X, Loader2, Zap, Info } from "lucide-react";
import {
  type SeatTier,
  type SeatData,
  type SessionData,
  purchaseTicket,
  holdSeats,
  applyLottery,
  getPointBalance,
} from "@pickket/lib/api";
import { formatKRW, normalizeSaleMode, cn } from "@pickket/lib";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { toast } from "sonner";

interface MobileBookingSheetProps {
  tiers: SeatTier[];
  sessions: SessionData[];
  selectedTierId: string | null;
  selectedSessionEventId: string | null;
  selectedSeats: SeatData[];
  quantity: number;
  isAssignedSeating: boolean;
  onSelectTier: (tierId: string) => void;
  onSetQuantity: (qty: number) => void;
  onToggleSeat: (seat: SeatData) => void;
  onSetSelectedSeats: (seats: SeatData[]) => void;
  eventTitle: string;
  eventId: string;
  category?: string;
  onOrderCreated: (orderId: string, totalPrice: number) => void;
  onAuthRequired: () => void;
  onLotteryApplied?: () => void;
  seatSelectionActive?: boolean;
  onGoToSeatSelection?: () => void;
  onExitSeatSelection?: () => void;
}

const SALE_MODE_KEYS: Record<string, string> = {
  fixed_fcfs: "saleModeFixed",
  lottery: "saleModeLottery",
  fanclub: "saleModeFanclub",
};

const _TIER_COLORS = [
  "#7B61FF",
  "#FFD700",
  "#01f5a0",
  "#00D1FF",
  "#FF00FF",
  "#FF6B6B",
];

export default function MobileBookingSheet({
  tiers,
  selectedTierId,
  selectedSeats,
  quantity,
  isAssignedSeating,
  onSelectTier: _onSelectTier,
  onSetQuantity,
  onToggleSeat,
  onSetSelectedSeats: _onSetSelectedSeats,
  eventTitle: _eventTitle,
  eventId,
  onOrderCreated,
  onAuthRequired,
  onLotteryApplied,
  seatSelectionActive,
  onGoToSeatSelection,
  onExitSeatSelection,
}: MobileBookingSheetProps) {
  const t = useTranslations("booking.mobileSheet");
  const { user } = useAuthStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lotteryApplied, setLotteryApplied] = useState(false);
  const [investedAp, setInvestedAp] = useState<number>(0);
  const [showLotteryConfirm, setShowLotteryConfirm] = useState(false);
  const [showApSlider, setShowApSlider] = useState(false);

  const { data: pointData } = useQuery({
    queryKey: ["points", "balance"],
    queryFn: async () => {
      const res = await getPointBalance();
      return res.data as { fan: number; social: number };
    },
    enabled: !!user,
  });
  const pointBalance = pointData?.fan ?? 0;
  const pointLoaded = !!pointData;

  const selectedTier = tiers.find((t) => t.id === selectedTierId) ?? null;
  const maxQty = selectedTier?.max_group_size ?? 4;
  const unitPrice = selectedTier
    ? (selectedTier.face_price ?? selectedTier.base_price)
    : 0;
  const count = isAssignedSeating ? selectedSeats.length : quantity;
  const totalPrice = unitPrice * count;
  const saleMode = selectedTier
    ? normalizeSaleMode(selectedTier.sale_mode)
    : "fixed_fcfs";
  const isLottery = selectedTier
    ? saleMode === "lottery"
    : tiers.some((t) => normalizeSaleMode(t.sale_mode) === "lottery");

  const canProceedToPayment = useMemo(() => {
    if (!selectedTierId) return false;
    if (isAssignedSeating) return selectedSeats.length > 0;
    return quantity > 0;
  }, [selectedTierId, isAssignedSeating, selectedSeats.length, quantity]);

  const handleCta = async () => {
    if (!user) {
      onAuthRequired();
      return;
    }
    if (!selectedTier) return;
    if (isLottery) {
      setShowLotteryConfirm(true);
      return;
    }
    await executeSubmit();
  };

  const executeSubmit = async () => {
    if (!selectedTier) return;
    setIsSubmitting(true);
    try {
      if (isLottery) {
        const clientSeed = crypto.randomUUID();
        await applyLottery(eventId, selectedTier.id, {
          group_size: count,
          client_seed: clientSeed,
          invested_ap: investedAp > 0 ? investedAp : undefined,
        });
        toast.success(
          t("toastLotterySuccess", {
            count: count ?? 0,
            apPart: investedAp > 0 ? t("toastApInvested", { ap: investedAp ?? 0 }) : "",
          }),
        );
        setLotteryApplied(true);
        setShowLotteryConfirm(false);
        onLotteryApplied?.();
      } else {
        const seatIds = selectedSeats
          .map((s) => s.id)
          .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id));
        if (seatIds.length > 0) {
          try {
            await holdSeats(eventId, { seat_ids: seatIds });
          } catch {
            throw new Error(t("errorHoldFailed"));
          }
        }
        const orderRes = await purchaseTicket(eventId, selectedTier.id, {
          quantity: count,
          seat_ids: seatIds.length > 0 ? seatIds : undefined,
          idempotency_key: crypto.randomUUID(),
        });
        const created = orderRes.data;
        if (!created?.success || !created.order_id) {
          throw new Error(created?.message || t("errorOrderFailed"));
        }
        onOrderCreated(created.order_id, created.total_price ?? totalPrice);
      }
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } }; message?: string })
          ?.response?.data?.detail ||
        (err as { message?: string })?.message ||
        t("errorGeneric");
      toast.error(detail);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      {/* 상단 탭 제거 — 좌석배치도에서 직접 구역 클릭 */}

      {/* ══════ 하단 고정 바 ══════ */}
      <div
        role="region"
        aria-label={t("ariaBookingSummary")}
        className="fixed bottom-0 left-0 right-0 z-40 bg-background border-t border-border"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {!seatSelectionActive ? (
          /* ── 구역 선택 단계: 선택 구역 정보 + CTA ── */
          <div className="px-4 pt-3 pb-3">
            {selectedTier ? (
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-bold text-foreground">
                    {selectedTier.name}
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    {t("remainingSeats", { count: selectedTier.remaining ?? 0 })}
                    {SALE_MODE_KEYS[
                      normalizeSaleMode(selectedTier.sale_mode)
                    ] && (
                      <span className="ml-1.5 text-primary/70">
                        ·{" "}
                        {t(
                          SALE_MODE_KEYS[
                            normalizeSaleMode(selectedTier.sale_mode)
                          ],
                        )}
                      </span>
                    )}
                  </p>
                </div>
                <p className="text-xl font-black text-foreground tabular-nums">
                  {formatKRW(unitPrice)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center mb-3">
                {t("selectTierHint")}
              </p>
            )}
            <button
              type="button"
              disabled={!selectedTierId}
              onClick={() => onGoToSeatSelection?.()}
              className={cn(
                "w-full py-3.5 rounded-2xl font-bold text-base transition-all active:scale-[0.98]",
                !selectedTierId
                  ? "bg-primary/30 text-white/50 cursor-not-allowed"
                  : "bg-primary text-white hover:brightness-110 shadow-lg shadow-primary/30",
              )}
            >
              {!selectedTierId
                ? t("ctaSelectTier")
                : isLottery
                  ? t("ctaSetupLottery")
                  : isAssignedSeating
                    ? t("ctaGoSeatSelection")
                    : t("ctaSelectQuantity")}
            </button>
          </div>
        ) : (
          /* ── 좌석 선택 단계 ── */
          <div className="px-4 pt-3 pb-3">
            {/* 선택된 좌석 칩 (지정석) */}
            {isAssignedSeating && selectedSeats.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {selectedSeats.map((seat) => (
                  <button
                    key={seat.id}
                    type="button"
                    onClick={() => onToggleSeat(seat)}
                    aria-label={t("ariaSeatDeselect", { seat: seat.label || t("seatLabel", { row: seat.row_number ?? 0, num: seat.seat_number ?? 0 }) })}
                    className="inline-flex items-center gap-1 bg-primary text-white text-2xs px-2 py-1 rounded-full"
                  >
                    <span className="truncate max-w-24">
                      {seat.label ||
                        t("seatLabel", { row: seat.row_number ?? 0, num: seat.seat_number ?? 0 })}
                    </span>
                    <X className="h-2.5 w-2.5 shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {/* 비지정석 수량 선택 */}
            {!isAssignedSeating && selectedTier && (
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-muted-foreground">
                  {t("tierQuantityLabel", { name: selectedTier.name ?? "" })}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onSetQuantity(quantity - 1)}
                    disabled={quantity <= 1}
                    aria-label={t("ariaQtyDecrease", { current: quantity ?? 0 })}
                    className="w-8 h-8 rounded-full border border-input flex items-center justify-center disabled:opacity-30"
                  >
                    <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <span
                    className="text-lg font-black tabular-nums w-6 text-center"
                    role="status"
                    aria-live="polite"
                    aria-label={t("ariaQtySelected", { count: quantity ?? 0 })}
                  >
                    {quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSetQuantity(quantity + 1)}
                    disabled={
                      quantity >= Math.min(maxQty, selectedTier.remaining)
                    }
                    aria-label={t("ariaQtyIncrease", { current: quantity ?? 0, max: maxQty ?? 0 })}
                    className="w-8 h-8 rounded-full border border-input flex items-center justify-center disabled:opacity-30"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}

            {/* AP 투자 (lottery) */}
            {saleMode === "lottery" && selectedTier && (
              <button
                type="button"
                onClick={() => setShowApSlider(true)}
                className="flex items-center justify-between w-full mb-2 text-sm"
              >
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Zap className="h-3.5 w-3.5 text-amber-500" />
                  {t("investAp")}
                </span>
                <span className="font-bold text-primary">
                  {investedAp.toLocaleString()} AP{" "}
                  <span className="text-2xs text-muted-foreground ml-1">
                    {t("changeAp")}
                  </span>
                </span>
              </button>
            )}

            {/* 가격 + CTA */}
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">
                  {selectedTier?.name} {count > 0 ? t("countUnit", { count: count ?? 0 }) : ""}
                </p>
                <p className="text-lg font-black text-foreground tabular-nums">
                  {totalPrice > 0
                    ? formatKRW(totalPrice)
                    : t("selectSeatHint")}
                </p>
              </div>
              {lotteryApplied && isLottery ? (
                <button
                  type="button"
                  disabled
                  className="shrink-0 px-6 py-3 rounded-2xl font-bold text-sm bg-emerald-600 text-white"
                >
                  {t("lotteryAppliedBtn")}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canProceedToPayment || isSubmitting}
                  onClick={handleCta}
                  className={cn(
                    "shrink-0 px-6 py-3 rounded-2xl font-bold text-sm transition-all active:scale-95",
                    !canProceedToPayment || isSubmitting
                      ? "bg-primary/30 text-white/50"
                      : "bg-primary text-white hover:brightness-110",
                  )}
                >
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : !user ? (
                    t("ctaLogin")
                  ) : isLottery ? (
                    t("ctaApply")
                  ) : (
                    t("ctaPay")
                  )}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onExitSeatSelection}
              className="w-full mt-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("backToTierSelection")}
            </button>
          </div>
        )}
      </div>

      {/* ── AP 투자 모달 ── */}
      <Dialog open={showApSlider} onOpenChange={setShowApSlider}>
        <DialogContent className="sm:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Zap className="h-5 w-5 text-amber-500" />
              {t("apModalTitle")}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {t("apModalDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-3">
            {pointLoaded && (
              <p className="text-xs text-right text-muted-foreground">
                {t("apBalance", { balance: pointBalance ?? 0 })}
              </p>
            )}
            <div className="text-center">
              <p className="text-3xl font-black text-primary tabular-nums">
                {investedAp.toLocaleString()}{" "}
                <span className="text-sm font-medium text-muted-foreground">
                  AP
                </span>
              </p>
            </div>
            <input
              type="range"
              min={0}
              max={Math.min(2500, pointBalance)}
              step={100}
              value={investedAp}
              onChange={(e) => setInvestedAp(Number(e.target.value))}
              className="w-full h-2 rounded-full appearance-none bg-border cursor-pointer accent-primary"
            />
            <div className="flex gap-2">
              {[0, 500, 1000, 1500, 2500].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setInvestedAp(Math.min(v, pointBalance))}
                  className={cn(
                    "flex-1 py-1.5 rounded-lg text-xs font-medium",
                    investedAp === v
                      ? "bg-primary text-white"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {v === 0
                    ? t("apNone")
                    : `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K`}
                </button>
              ))}
            </div>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded-lg p-2.5">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {t("apDisclaimerShort")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowApSlider(false)}
            className="w-full py-3 rounded-xl font-bold text-sm bg-primary text-white hover:brightness-110 transition-all"
          >
            {t("confirm")}
          </button>
        </DialogContent>
      </Dialog>

      {/* ── 응모 확인 모달 ── */}
      <Dialog open={showLotteryConfirm} onOpenChange={setShowLotteryConfirm}>
        <DialogContent className="sm:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Zap className="h-5 w-5 text-amber-500" />
              {t("lotteryConfirmTitle")}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {t("lotteryConfirmDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t("labelTier")}</span>
              <span className="font-medium">{selectedTier?.name}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t("labelTicketCount")}</span>
              <span className="font-medium">{t("countUnit", { count: count ?? 0 })}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t("labelInvestedAp")}</span>
              <span className="font-bold text-primary">
                {investedAp.toLocaleString()} AP
              </span>
            </div>
            <div className="border-t border-border pt-3 flex justify-between text-sm">
              <span className="text-muted-foreground">{t("labelPaymentOnWin")}</span>
              <span className="font-bold text-emerald-600 dark:text-emerald-400">
                {formatKRW(totalPrice)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground/70 bg-muted/50 rounded-lg p-2.5">
              {t("apDisclaimerFull", { ap: investedAp ?? 0 })}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowLotteryConfirm(false)}
              className="flex-1 py-3 rounded-xl font-medium text-sm bg-muted text-foreground hover:bg-muted/80 transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={executeSubmit}
              className="flex-1 py-3 rounded-xl font-bold text-sm bg-primary text-white hover:brightness-110 transition-all disabled:opacity-50"
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("applyingLottery")}
                </span>
              ) : (
                t("ctaApply")
              )}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── 응모 완료 모달 ── */}
      <Dialog open={lotteryApplied} onOpenChange={() => {}}>
        <DialogContent
          className="sm:max-w-md bg-card border-border"
          showCloseButton={false}
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">{t("lotteryDoneTitle")}</DialogTitle>
          <div className="text-center space-y-4 py-4">
            <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto">
              <span className="text-3xl">🎉</span>
            </div>
            <h2 className="text-xl font-bold text-foreground">{t("lotteryDoneTitle")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("lotteryDoneMsg", { name: selectedTier?.name ?? "", count: count ?? 0 })}
              {investedAp > 0 && (
                <>
                  <br />
                  <span className="font-medium text-primary">
                    {investedAp.toLocaleString()} AP
                  </span>
                  {t("apInvestedSuffix")}
                </>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/"
              className="flex-1 py-3 rounded-xl font-medium text-sm text-center bg-muted text-foreground hover:bg-muted/80 transition-colors"
            >
              {t("goHome")}
            </Link>
            <Link
              href="/mypage?tab=bids"
              className="flex-1 py-3 rounded-xl font-bold text-sm text-center bg-primary text-white hover:brightness-110 transition-all"
            >
              {t("viewMyBids")}
            </Link>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

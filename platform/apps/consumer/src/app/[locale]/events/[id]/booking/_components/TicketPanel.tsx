"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import {
  Minus,
  Plus,
  Ticket,
  X,
  ShoppingCart,
  Loader2,
  Zap,
  Info,
} from "lucide-react";
import {
  type SeatTier,
  type SeatData,
  type SessionData,
  purchaseTicket,
  holdSeats,
  applyLottery,
  getPointBalance,
} from "@pickket/lib/api";
import { formatKRW, normalizeSaleMode } from "@pickket/lib";
import { cn } from "@pickket/lib";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { toast } from "sonner";

interface TicketPanelProps {
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

const ACTION_BTN_BASE =
  "w-full py-4 rounded-2xl font-bold text-base transition-all duration-200 active:scale-[0.98]";
const ACTION_BTN_PRIMARY =
  "bg-primary text-white hover:brightness-110 shadow-lg shadow-primary/30";
const ACTION_BTN_PRIMARY_DISABLED =
  "bg-primary/30 text-white/50 cursor-not-allowed";
const ACTION_BTN_SECONDARY =
  "bg-muted text-foreground hover:bg-muted/80 border border-border";

const SALE_MODE_KEYS: Record<string, string> = {
  fixed_fcfs: "saleModeFixedFcfs",
  lottery: "saleModeLottery",
  fanclub: "saleModeFanclub",
};

export default function TicketPanel({
  tiers,
  sessions,
  selectedTierId,
  selectedSessionEventId,
  selectedSeats,
  quantity,
  isAssignedSeating,
  onSelectTier,
  onSetQuantity,
  onToggleSeat,
  onSetSelectedSeats,
  eventTitle,
  eventId,
  category: _category,
  onOrderCreated,
  onAuthRequired,
  onLotteryApplied,
  seatSelectionActive,
  onGoToSeatSelection,
  onExitSeatSelection,
}: TicketPanelProps) {
  const t = useTranslations("booking.ticketPanel");
  const { user } = useAuthStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lotteryApplied, setLotteryApplied] = useState(false);
  const [investedAp, setInvestedAp] = useState<number>(0);
  const [showLotteryConfirm, setShowLotteryConfirm] = useState(false);

  // 포인트 잔액 조회 (TanStack Query)
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

  const selectedSession = useMemo(
    () => sessions.find((s) => s.event_id === selectedSessionEventId) ?? null,
    [sessions, selectedSessionEventId],
  );

  const canProceedToPayment = useMemo(() => {
    if (!selectedTierId) return false;
    if (isAssignedSeating) return selectedSeats.length > 0;
    return quantity > 0;
  }, [selectedTierId, isAssignedSeating, selectedSeats.length, quantity]);

  /* ── CTA 클릭 핸들러 ── */
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
          investedAp > 0
            ? t("toastLotterySuccessWithAp", { count, ap: investedAp })
            : t("toastLotterySuccess", { count }),
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
            throw new Error(t("errorHoldSeatsFailed"));
          }
        }

        const orderRes = await purchaseTicket(eventId, selectedTier.id, {
          quantity: count,
          seat_ids: seatIds.length > 0 ? seatIds : undefined,
          idempotency_key: crypto.randomUUID(),
        });
        const created = orderRes.data;
        if (!created?.success || !created.order_id) {
          throw new Error(created?.message || t("errorOrderCreateFailed"));
        }
        onOrderCreated(created.order_id, created.total_price ?? totalPrice);
      }
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } }; message?: string })
          ?.response?.data?.detail ||
        (err as { message?: string })?.message ||
        t("errorProcessFailed");
      toast.error(detail);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="w-full lg:w-[420px] shrink-0 flex flex-col justify-between border-l-0 lg:border-l border-border bg-background"
      style={{ height: "100%" }}
    >
      <div className="overflow-y-auto p-4 lg:p-5 space-y-5">
        {/* ── 1. 구역 선택 / 선택된 구역 표시 ── */}
        {seatSelectionActive && selectedTier ? (
          <section>
            <h3 className="flex items-center gap-2 text-sm font-bold text-foreground mb-3">
              <Ticket className="h-4 w-4 text-primary" />
              {t("selectedZone")}
            </h3>
            <div className="rounded-xl border border-primary bg-primary/5 ring-1 ring-primary/30 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="w-5 h-5 rounded-full border-2 border-primary bg-primary flex items-center justify-center shrink-0">
                    <span className="w-2 h-2 rounded-full bg-white" />
                  </span>
                  <span className="text-sm font-bold text-foreground">
                    {selectedTier.name}
                  </span>
                </div>
                <div className="text-right">
                  <p className="text-base font-black text-foreground tabular-nums">
                    {formatKRW(
                      selectedTier.face_price ?? selectedTier.base_price,
                    )}
                  </p>
                  <span className="text-2xs text-muted-foreground/60">
                    {t("seatsLeft", { count: selectedTier.remaining ?? 0 })}
                  </span>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section aria-labelledby="tier-select-heading">
            <h3
              id="tier-select-heading"
              className="flex items-center gap-2 text-sm font-bold text-foreground mb-3"
            >
              <Ticket className="h-4 w-4 text-primary" />
              {t("selectZone")}
            </h3>
            <div
              className="space-y-2"
              role="radiogroup"
              aria-labelledby="tier-select-heading"
            >
              {tiers.map((tier) => {
                const isSelected = selectedTierId === tier.id;
                const isSoldOut = tier.remaining <= 0;
                const fillPct =
                  tier.capacity > 0
                    ? Math.round(
                        ((tier.capacity - tier.remaining) / tier.capacity) *
                          100,
                      )
                    : 0;
                const saleModeKey = SALE_MODE_KEYS[normalizeSaleMode(tier.sale_mode)];
                const saleLabel = saleModeKey ? t(saleModeKey as "saleModeFixedFcfs" | "saleModeLottery" | "saleModeFanclub") : "";

                const tierPrice = tier.face_price ?? tier.base_price;
                const tierStatus = isSoldOut
                  ? t("soldOut")
                  : isSelected
                    ? t("selected")
                    : t("remainingSeats", { count: tier.remaining ?? 0 });
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => {
                      if (isSoldOut) return;
                      onSelectTier(tier.id);
                    }}
                    disabled={isSoldOut}
                    role="radio"
                    aria-checked={isSelected}
                    aria-disabled={isSoldOut}
                    aria-label={t("tierAriaLabel", { name: tier.name ?? "", price: formatKRW(tierPrice), status: tierStatus, saleLabel: saleLabel || "" })}
                    className={cn(
                      "relative w-full text-left rounded-xl border p-4 transition-all duration-200",
                      isSelected && !isSoldOut
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                        : isSoldOut
                          ? "border-border/40 bg-card/10 opacity-40 cursor-not-allowed"
                          : "border-border bg-card/30 hover:border-input hover:bg-card/50",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            "w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shrink-0",
                            isSelected
                              ? "border-primary bg-primary"
                              : "border-input",
                          )}
                        >
                          {isSelected && (
                            <span className="w-2 h-2 rounded-full bg-white" />
                          )}
                        </span>
                        <div>
                          <span className="text-sm font-bold text-foreground">
                            {tier.name}
                          </span>
                          {saleLabel && !isSoldOut && (
                            <span className="ml-2 text-2xs font-medium text-primary/70 bg-primary/10 px-2 py-0.5 rounded-full">
                              {saleLabel}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-base font-black text-foreground tabular-nums">
                          {formatKRW(tier.face_price ?? tier.base_price)}
                        </p>
                        {isSoldOut ? (
                          <span className="text-2xs font-bold text-red-600 dark:text-red-400">
                            {t("soldOut")}
                          </span>
                        ) : (
                          <span className="text-2xs text-muted-foreground/60">
                            {t("seatsLeft", { count: tier.remaining ?? 0 })}
                          </span>
                        )}
                      </div>
                    </div>
                    {!isSoldOut && (
                      <div className="mt-2 h-1 rounded-full bg-border overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            fillPct >= 80
                              ? "bg-red-500"
                              : fillPct >= 50
                                ? "bg-orange-400"
                                : "bg-primary",
                          )}
                          style={{ width: `${fillPct}%` }}
                        />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* ── 2. 수량 선택 (비지정석) — seat step에서만 ── */}
        <AnimatePresence>
          {seatSelectionActive && selectedTier && !isAssignedSeating && (
            <motion.section
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <h3
                id="qty-select-heading"
                className="text-sm font-bold text-foreground mb-3"
              >
                {t("selectQuantity")}
              </h3>
              <div
                className="flex items-center justify-between rounded-xl border border-border bg-card/30 p-4"
                role="group"
                aria-labelledby="qty-select-heading"
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {selectedTier.name}
                  </p>
                  <p className="text-xs text-muted-foreground/60">
                    {t("maxPerPerson", { max: maxQty ?? 0 })}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => onSetQuantity(quantity - 1)}
                    disabled={quantity <= 1}
                    aria-label={t("ariaDecreaseQty", { current: quantity ?? 0 })}
                    className="w-9 h-9 rounded-full border border-input flex items-center justify-center text-foreground hover:bg-card disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  >
                    <Minus className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <span
                    className="text-xl font-black text-foreground tabular-nums w-8 text-center"
                    role="status"
                    aria-live="polite"
                    aria-label={t("ariaCurrentQty", { count: quantity ?? 0 })}
                  >
                    {quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSetQuantity(quantity + 1)}
                    disabled={
                      quantity >= Math.min(maxQty, selectedTier.remaining)
                    }
                    aria-label={t("ariaIncreaseQty", { current: quantity ?? 0, max: maxQty ?? 0 })}
                    className="w-9 h-9 rounded-full border border-input flex items-center justify-center text-foreground hover:bg-card disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* ── 3. 선택된 좌석 리스트 (지정석) ── */}
        <AnimatePresence>
          {isAssignedSeating && selectedSeats.length > 0 && (
            <motion.section
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-foreground">
                  {t("selectedSeatsHeading", { selected: selectedSeats.length ?? 0, max: selectedTier?.max_group_size ?? 4 })}
                </h3>
                <button
                  type="button"
                  onClick={() => onSetSelectedSeats([])}
                  aria-label={t("ariaClearAllSeats")}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t("clearAll")}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedSeats.map((seat) => (
                  <motion.button
                    key={seat.id}
                    layout
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    type="button"
                    onClick={() => onToggleSeat(seat)}
                    aria-label={t("ariaDeselectSeat", { label: seat.label || t("seatLabel", { section: seat.section ?? "", row: seat.row_number ?? 0, number: seat.seat_number ?? 0 }) })}
                    className="inline-flex items-center gap-1 bg-primary text-white text-xs px-2.5 py-1.5 rounded-full hover:bg-primary/80 transition-colors max-w-40"
                  >
                    <span className="truncate">
                      {seat.label ||
                        t("seatLabel", { section: seat.section ?? "", row: seat.row_number ?? 0, number: seat.seat_number ?? 0 })}
                    </span>
                    <X className="h-3 w-3 shrink-0" />
                  </motion.button>
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* ── 3.5. AP 투입 (lottery + seat step) ── */}
        {saleMode === "lottery" && selectedTier && seatSelectionActive && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                <Zap className="h-4 w-4 text-amber-500" />
                {t("apInvest")}
              </h3>
              {pointLoaded && (
                <span className="text-xs text-muted-foreground">
                  {t("apBalance", { balance: pointBalance ?? 0 })}
                </span>
              )}
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-4">
              <div className="text-center">
                <p className="text-3xl font-black text-primary tabular-nums">
                  {investedAp.toLocaleString()}
                  <span className="text-sm font-medium text-muted-foreground ml-1">
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
                aria-label={t("ariaApSlider", { max: Math.min(2500, pointBalance) ?? 0 })}
                aria-valuemin={0}
                aria-valuemax={Math.min(2500, pointBalance)}
                aria-valuenow={investedAp}
                aria-valuetext={`${investedAp.toLocaleString()} AP`}
                className="w-full h-2 rounded-full appearance-none bg-border cursor-pointer accent-primary"
              />
              <div className="flex gap-2">
                {[0, 500, 1000, 1500, 2500].map((v) => {
                  const label =
                    v === 0
                      ? t("apNone")
                      : `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K`;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setInvestedAp(Math.min(v, pointBalance))}
                      aria-label={t("ariaApSelect", { label: label ?? "" })}
                      className={cn(
                        "flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors",
                        investedAp === v
                          ? "bg-primary text-white"
                          : "bg-muted text-muted-foreground hover:bg-muted/80",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <div>
                  <p>{t("apInfoMain")}</p>
                  <p className="mt-1 text-muted-foreground/70">
                    {t("apInfoSub")}
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ── 4. 주문 요약 — seat step에서만 ── */}
        <AnimatePresence>
          {seatSelectionActive && selectedTier && count > 0 && (
            <motion.section
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.2 }}
              id="booking-order-summary"
              aria-labelledby="booking-order-summary-heading"
              className="rounded-xl border border-border bg-card/30 p-4 space-y-3"
            >
              <div className="flex items-center gap-2">
                <ShoppingCart
                  className="h-4 w-4 text-primary"
                  aria-hidden="true"
                />
                <h3
                  id="booking-order-summary-heading"
                  className="text-sm font-semibold text-foreground"
                >
                  {t("orderSummary")}
                </h3>
              </div>

              <div className="text-sm font-medium text-foreground truncate">
                {eventTitle}
              </div>

              {selectedSession && (
                <div className="text-xs text-muted-foreground">
                  {new Date(selectedSession.event_date).toLocaleDateString(
                    "ko-KR",
                    {
                      month: "long",
                      day: "numeric",
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    },
                  )}
                </div>
              )}

              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("tierCountLabel", { name: selectedTier.name ?? "", count: count ?? 0 })}
                </span>
                <span className="font-medium text-foreground tabular-nums">
                  {formatKRW(unitPrice)}
                </span>
              </div>

              {isAssignedSeating && selectedSeats.length > 0 && (
                <div className="space-y-1">
                  {selectedSeats.map((seat) => (
                    <div
                      key={seat.id}
                      className="text-xs text-muted-foreground pl-2 border-l-2 border-primary/20"
                    >
                      {seat.label ||
                        t("seatLabel", { section: seat.section ?? "", row: seat.row_number ?? 0, number: seat.seat_number ?? 0 })}
                    </div>
                  ))}
                </div>
              )}

              <div className="border-t border-border pt-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm text-foreground">
                    {t("totalAmount")}
                  </span>
                  <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                    {formatKRW(totalPrice)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground/60 mt-0.5">
                  {t("vatIncluded")}
                </p>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </div>

      {/* ── 5. CTA 버튼 (하단) ── */}
      <div className="p-4 lg:p-5 mb-4 space-y-2">
        {!seatSelectionActive ? (
          <button
            type="button"
            disabled={!selectedTierId}
            onClick={() => onGoToSeatSelection?.()}
            className={cn(
              ACTION_BTN_BASE,
              !selectedTierId
                ? ACTION_BTN_PRIMARY_DISABLED
                : ACTION_BTN_PRIMARY,
            )}
          >
            {!selectedTierId
              ? t("ctaSelectZone")
              : isLottery
                ? t("ctaSetupLottery")
                : isAssignedSeating
                  ? t("ctaGoToSeatSelection")
                  : t("ctaSelectQuantity")}
          </button>
        ) : (
          <>
            {lotteryApplied && isLottery ? (
              <button
                type="button"
                disabled
                className={cn(
                  ACTION_BTN_BASE,
                  "bg-emerald-600 text-white cursor-default",
                )}
              >
                {t("lotteryAppliedDone")}
              </button>
            ) : (
              <button
                type="button"
                disabled={!canProceedToPayment || isSubmitting}
                onClick={handleCta}
                aria-describedby="booking-order-summary"
                aria-busy={isSubmitting}
                className={cn(
                  ACTION_BTN_BASE,
                  !canProceedToPayment || isSubmitting
                    ? ACTION_BTN_PRIMARY_DISABLED
                    : ACTION_BTN_PRIMARY,
                )}
              >
                {isSubmitting ? (
                  <span
                    className="flex items-center justify-center gap-2"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    {isLottery ? t("submittingLottery") : t("submittingOrder")}
                  </span>
                ) : !user ? (
                  t("ctaLogin")
                ) : isAssignedSeating && selectedSeats.length === 0 ? (
                  t("ctaSelectSeat")
                ) : isLottery ? (
                  investedAp > 0
                    ? t("ctaApplyWithAp", { ap: investedAp })
                    : t("ctaApply")
                ) : (
                  totalPrice > 0
                    ? t("ctaPayWithAmount", { amount: formatKRW(totalPrice) })
                    : t("ctaPay")
                )}
              </button>
            )}
            <button
              type="button"
              onClick={onExitSeatSelection}
              aria-label={t("ctaReselectZone")}
              className={cn(ACTION_BTN_BASE, ACTION_BTN_SECONDARY)}
            >
              {t("ctaReselectZoneBtn")}
            </button>
          </>
        )}
      </div>

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
              <span className="text-muted-foreground">{t("confirmZone")}</span>
              <span className="font-medium">{selectedTier?.name}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t("confirmTicketCount")}</span>
              <span className="font-medium">{t("ticketCountValue", { count: count ?? 0 })}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t("confirmInvestedAp")}</span>
              <span className="font-bold text-primary">
                {investedAp.toLocaleString()} AP
              </span>
            </div>
            <div className="border-t border-border pt-3 flex justify-between text-sm">
              <span className="text-muted-foreground">{t("confirmPaymentOnWin")}</span>
              <span className="font-bold text-emerald-600 dark:text-emerald-400">
                {formatKRW(totalPrice)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground/70 bg-muted/50 rounded-lg p-2.5">
              {t("lotteryConfirmApNote", { ap: investedAp ?? 0 })}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowLotteryConfirm(false)}
              aria-label={t("ariaLotteryCancel")}
              className="flex-1 py-3 rounded-xl font-medium text-sm bg-muted text-foreground hover:bg-muted/80 transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={executeSubmit}
              aria-label={t("ariaLotteryConfirm")}
              className="flex-1 py-3 rounded-xl font-bold text-sm bg-primary text-white hover:brightness-110 transition-all disabled:opacity-50"
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("applying")}
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
            <h2 className="text-xl font-bold text-foreground">{t("lotteryDoneBanner")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("lotteryDoneDesc", { name: selectedTier?.name ?? "", count: count ?? 0 })}
              {investedAp > 0 && (
                <>
                  <br />
                  <span className="font-medium text-primary">
                    {investedAp.toLocaleString()} AP
                  </span>
                  {t("lotteryDoneApSuffix")}
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground/70">
              {t("lotteryDoneResultNote")}
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
              {t("myBids")}
            </Link>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

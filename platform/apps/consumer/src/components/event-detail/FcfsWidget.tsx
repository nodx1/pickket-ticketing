"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@pickket/store";
import {
  purchaseTicket,
  holdSeats,
  getMyEventStatus,
  type EventDetail,
  type SeatTier,
  type SeatData,
} from "@pickket/lib/api";
import { useQuery } from "@tanstack/react-query";
import { formatKRW } from "@pickket/lib";
import { usePayment } from "@/hooks/usePayment";
import OrderConfirmationModal from "@/components/payment/OrderConfirmationModal";
import PaymentCompleteModal from "@/components/payment/PaymentCompleteModal";
import PaymentErrorModal from "@/components/payment/PaymentErrorModal";
import { Button } from "@pickket/ui";
import { toast } from "sonner";
import { ShoppingCart, Check, AlertTriangle, Bell } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { getOrganizerLabels } from "@pickket/lib";
import { clearPersistedBooking } from "@/hooks/useBookingFlow";

interface FcfsWidgetProps {
  event: EventDetail;
  tier: SeatTier;
  selectedSeats?: SeatData[];
  externalQuantity?: number;
  holdId?: string | null;
  onAuthRequired?: () => void;
}

export default function FcfsWidget({
  event,
  tier,
  selectedSeats,
  externalQuantity,
  onAuthRequired,
}: FcfsWidgetProps) {
  const t = useTranslations("event.fcfsWidget");
  const orgLabels = getOrganizerLabels(event.category);
  const router = useRouter();
  const { user } = useAuthStore();
  const [quantity, setQuantity] = useState(1);
  const [success, setSuccess] = useState(false);
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);

  // 기존 구매 여부 확인 (쿠키 인증 — user 상태 불필요)
  useQuery({
    queryKey: ["events", event.id, "myTicketStatus"],
    queryFn: async () => {
      const res = await getMyEventStatus(event.id);
      if (res.data.has_ticket) setSuccess(true);
      return res.data;
    },
  });
  const effectiveQuantity = externalQuantity ?? quantity;
  const unitPrice = tier.face_price ?? tier.base_price;
  const totalPrice = unitPrice * effectiveQuantity;
  const isSoldOut = tier.remaining === 0;
  const isLowStock = tier.remaining > 0 && tier.remaining <= 10;

  // 결제확정은 토스 결제 성공 후 success 페이지(POST /orders/{id}/pay)에서 처리.
  // 이 콜백은 확정 이후 UI 정리만 한다. (감사 P0-D)
  const payment = usePayment(async () => {
    setSuccess(true);
    clearPersistedBooking(event.id);
  }, event.allowed_pay_methods);

  const handlePurchase = async () => {
    if (!user) {
      onAuthRequired?.();
      return;
    }
    try {
      setIsCreatingOrder(true);
      const seatIds = selectedSeats
        ?.map((s) => s.id)
        .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id));

      // 좌석이 선택된 경우 hold 먼저 확보
      if (seatIds?.length) {
        try {
          await holdSeats(event.id, { seat_ids: seatIds });
        } catch {
          throw new Error(t("errorSeatHoldFailed"));
        }
      }

      const orderRes = await purchaseTicket(event.id, tier.id, {
        quantity: effectiveQuantity,
        seat_ids: seatIds?.length ? seatIds : undefined,
        idempotency_key: crypto.randomUUID(),
      });
      const created = orderRes.data;
      if (!created?.success || !created.order_id) {
        throw new Error(created?.message || t("errorOrderCreateFailed"));
      }
      payment.openConfirmation(
        {
          eventTitle: event.title,
          tierName: tier.name,
          unitPrice,
          quantity: effectiveQuantity,
          fees: { platformFee: 0, organizerShare: 0 },
          totalAmount: created.total_price ?? totalPrice,
        },
        created.order_id,
      );
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } }; message?: string })
          ?.response?.data?.detail ||
        (err as { message?: string })?.message ||
        t("errorOrderPrepareFailed");
      toast.error(detail);
    } finally {
      setIsCreatingOrder(false);
    }
  };

  const hasExternalSeats = selectedSeats && selectedSeats.length > 0;

  return (
    <div className="space-y-5">
      {/* Price display */}
      <div className="text-center">
        <div className="inline-block mb-1.5 bg-emerald-600/10 text-emerald-600 dark:text-emerald-400 border border-emerald-600/20 rounded-full px-3 py-0.5 text-xs font-medium">
          {t("labelFacePrice")}
        </div>
        <p className="text-3xl font-bold text-foreground font-tabular">
          {formatKRW(unitPrice)}
        </p>
        <p className="text-2xs text-muted-foreground/60 mt-0.5">{t("labelVatIncluded")}</p>
      </div>

      {/* Remaining seats */}
      <div className="flex items-center justify-center gap-2">
        {isSoldOut ? (
          <span className="flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" />
            {t("labelSoldOut")}
          </span>
        ) : isLowStock ? (
          <span className="text-sm font-semibold text-red-600 dark:text-red-400 animate-pulse">
            {t("labelLowStock", { remaining: tier.remaining ?? 0 })}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("labelRemainingSeats", { remaining: tier.remaining ?? 0 })}
          </span>
        )}
      </div>

      {/* Selected seats display or Quantity selector */}
      {hasExternalSeats ? (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t("labelSelectedSeats")}</p>
          <div className="flex flex-wrap gap-2">
            {selectedSeats.map((seat) => (
              <span
                key={seat.id}
                className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary/70"
              >
                {seat.label ||
                  t("seatLabel", { section: seat.section ?? "", row: seat.row_number ?? "", number: seat.seat_number ?? "" })}
              </span>
            ))}
          </div>
        </div>
      ) : externalQuantity === undefined ? (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t("labelQuantity")}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={isSoldOut}
              className="size-10 rounded-full bg-card hover:bg-muted flex items-center justify-center font-bold text-foreground transition-colors disabled:opacity-50"
            >
              -
            </button>
            <span className="text-lg font-bold text-foreground min-w-[2ch] text-center">
              {quantity}
            </span>
            <button
              type="button"
              onClick={() =>
                setQuantity((q) => Math.min(tier.max_group_size ?? 4, q + 1))
              }
              disabled={isSoldOut}
              className="size-10 rounded-full bg-card hover:bg-muted flex items-center justify-center font-bold text-foreground transition-colors disabled:opacity-50"
            >
              +
            </button>
            <span className="text-xs text-muted-foreground">
              {t("labelMaxTickets", { max: tier.max_group_size ?? 4 })}
            </span>
          </div>
        </div>
      ) : null}

      {/* Price summary */}
      <div className="bg-card border border-border rounded-2xl p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("labelUnitXQty")}</span>
          <span className="text-foreground font-tabular">
            {formatKRW(unitPrice)} x {effectiveQuantity}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("labelFee")}</span>
          <span className="text-muted-foreground font-medium">
            {t("labelFeeInfo")}
          </span>
        </div>
        <div className="border-t border-border pt-2 flex justify-between items-baseline">
          <span className="font-semibold text-sm text-foreground">{t("labelTotal")}</span>
          <div>
            <span className="font-bold text-foreground font-tabular">
              {formatKRW(totalPrice)}
            </span>
            <span className="text-2xs text-muted-foreground/60 ml-1">
              {t("labelVatIncludedShort")}
            </span>
          </div>
        </div>
      </div>

      {/* CTA / Success */}
      <AnimatePresence mode="wait">
        {success ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-emerald-600/10 border border-emerald-600/20 rounded-2xl p-5 text-center space-y-2"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            >
              <Check className="h-10 w-10 text-emerald-600 dark:text-emerald-400 mx-auto" />
            </motion.div>
            <p className="font-bold text-emerald-600 dark:text-emerald-400">
              {t("successSecured", { ticketNoun: orgLabels.ticketNoun ?? "" })}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                router.push("/mypage");
              }}
              className="rounded-full mt-2 border-border text-foreground"
            >
              {t("ctaViewMyTickets", { ticketNoun: getOrganizerLabels(event.category).ticketNoun ?? "" })}
            </Button>
          </motion.div>
        ) : isSoldOut ? (
          <motion.div key="soldout" exit={{ opacity: 0 }} className="space-y-3">
            <Button
              type="button"
              disabled
              className="w-full rounded-full h-12 text-base font-semibold"
            >
              {t("labelSoldOut")}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                toast.info(t("toastAlertRegistered"))
              }
              className="w-full rounded-full h-10 text-sm border-border text-foreground"
            >
              <Bell className="h-4 w-4 mr-1.5" />
              {t("ctaNotifyOpen", { ticketNoun: orgLabels.ticketNoun ?? "" })}
            </Button>
          </motion.div>
        ) : (
          <motion.div key="cta" exit={{ opacity: 0 }}>
            <Button
              type="button"
              onClick={handlePurchase}
              disabled={isCreatingOrder}
              className="w-full rounded-full bg-gradient-to-r from-primary to-[#404040] text-white font-bold shadow-[0_8px_32px_rgba(10,10,10,0.4)] hover:brightness-110 h-12 text-base"
            >
              {isCreatingOrder ? (
                t("ctaOrderPreparing")
              ) : !user ? (
                t("ctaLoginThenBuy", { verb: orgLabels.ctaVerb ?? "" })
              ) : (
                <span className="flex items-center gap-2">
                  <ShoppingCart className="h-5 w-5" />
                  {t("ctaBuyNow", { verb: orgLabels.ctaVerb ?? "" })}
                </span>
              )}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Payment modals */}
      {payment.orderInfo && (
        <>
          <OrderConfirmationModal
            open={
              payment.phase === "confirming" || payment.phase === "processing"
            }
            phase={payment.phase}
            orderInfo={payment.orderInfo}
            agreed={payment.agreed}
            widgetReady={payment.widgetReady}
            showNiceMethods={payment.showNiceMethods}
            niceMethods={payment.niceMethods}
            niceMethod={payment.niceMethod}
            onNiceMethodChange={payment.setNiceMethod}
            niceCardOnly={payment.niceCardOnly}
            provider={payment.provider}
            onCancelProcessing={payment.cancelProcessing}
            onAgreedChange={payment.setAgreed}
            onConfirm={payment.executePayment}
            onClose={() => {
              payment.closeModal();
            }}
          />
          {payment.paymentResult && (
            <PaymentCompleteModal
              open={payment.phase === "complete"}
              paymentResult={payment.paymentResult}
              orderInfo={payment.orderInfo}
              onViewTickets={() => {
                router.push("/mypage");
              }}
              onBrowseEvents={() => {
                router.push("/browse");
              }}
              onClose={() => {
                payment.reset();
                clearPersistedBooking(event.id);
              }}
            />
          )}
          {payment.errorMessage && (
            <PaymentErrorModal
              open={payment.phase === "error"}
              errorMessage={payment.errorMessage}
              onRetry={payment.executePayment}
              onChangeMethod={payment.retryPayment}
              onClose={() => {
                payment.closeModal();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@pickket/store";
import {
  purchaseFanclub,
  type EventDetail,
  type SeatTier,
  type SeatData,
} from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";
import { usePayment } from "@/hooks/usePayment";
import OrderConfirmationModal from "@/components/payment/OrderConfirmationModal";
import PaymentCompleteModal from "@/components/payment/PaymentCompleteModal";
import PaymentErrorModal from "@/components/payment/PaymentErrorModal";
import { Button } from "@pickket/ui";
import { toast } from "sonner";
import { ShoppingCart, Check, Heart, Lock, ExternalLink } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { getDomainLabels, getOrganizerLabels } from "@pickket/lib";
import { clearPersistedBooking } from "@/hooks/useBookingFlow";

interface FanclubWidgetProps {
  event: EventDetail;
  tier: SeatTier;
  selectedSeats?: SeatData[];
  externalQuantity?: number;
  holdId?: string | null;
  onAuthRequired?: () => void;
}

export default function FanclubWidget({
  event,
  tier,
  selectedSeats,
  externalQuantity,
  onAuthRequired,
}: FanclubWidgetProps) {
  const router = useRouter();
  const { user } = useAuthStore();
  const [quantity, setQuantity] = useState(1);
  const [success, setSuccess] = useState(false);
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);

  const t = useTranslations("event.fanclubWidget");
  const orgLabels = getOrganizerLabels(event.category);
  const labels = getDomainLabels(event.category);
  const effectiveQuantity = externalQuantity ?? quantity;
  // Check per-community membership if event has a community_id,
  // otherwise fall back to global is_fanclub_member flag
  const isFanclubMember =
    event.community_id && user?.fanclub_memberships
      ? user.fanclub_memberships.some(
          (m) => m.fanclub_id === event.community_id && m.status === "active",
        )
      : (user?.is_fanclub_member ?? false);
  const isSoldOut = tier.remaining === 0;

  const discountPct = tier.fanclub_discount_pct ?? 0;
  const originalPrice = tier.face_price || tier.base_price;
  const discountedPrice =
    discountPct > 0 ? originalPrice * (1 - discountPct / 100) : originalPrice;
  const hasDiscount = discountPct > 0;
  const displayPrice = hasDiscount ? discountedPrice : originalPrice;
  const totalPrice = displayPrice * effectiveQuantity;
  const savingsPerTicket = hasDiscount ? originalPrice - discountedPrice : 0;

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
    if (!isFanclubMember) {
      toast.error(
        t("errorMemberOnly", { community: labels.communityLabel ?? "", member: labels.memberLabel ?? "" }),
      );
      return;
    }
    try {
      setIsCreatingOrder(true);
      const orderRes = await purchaseFanclub(event.id, tier.id, {
        quantity: effectiveQuantity,
        seat_ids: selectedSeats?.map((s) => s.id),
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
          unitPrice: displayPrice,
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

  if (!isFanclubMember) {
    return (
      <div className="space-y-5">
        <div className="flex justify-center">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400">
            <Heart className="h-3.5 w-3.5" />
            {t("badgeExclusive", { community: labels.communityLabel ?? "" })}
          </span>
        </div>

        <div className="bg-muted rounded-2xl p-6 text-center space-y-4">
          <Lock className="h-10 w-10 text-muted-foreground mx-auto" />
          <p className="font-semibold text-foreground">
            {t("lockedTitle", { community: labels.communityLabel ?? "", member: labels.memberLabel ?? "" })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("lockedDesc", { community: labels.communityLabel ?? "" })}
          </p>
          {hasDiscount && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-cyan/10 text-cyan font-tabular">
              {t("joinDiscount", { amount: formatKRW(savingsPerTicket) })}
            </div>
          )}
          <Button variant="outline" asChild className="rounded-full">
            <Link
              href={`/events/${event.id}/fanclub`}
              className="inline-flex items-center gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("joinCta", { community: labels.communityLabel ?? "" })}
            </Link>
          </Button>
        </div>

        <div className="text-center opacity-60">
          {hasDiscount && (
            <p className="text-sm text-muted-foreground line-through font-tabular">
              {formatKRW(originalPrice)}
            </p>
          )}
          <p className="text-2xl font-bold text-primary font-tabular">
            {formatKRW(displayPrice)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400">
          <Heart className="h-3.5 w-3.5" />
          {t("badgeExclusive", { community: labels.communityLabel ?? "" })}
        </span>
      </div>

      <div className="text-center">
        {hasDiscount && (
          <p className="text-sm text-muted-foreground line-through font-tabular">
            {formatKRW(originalPrice)}
          </p>
        )}
        <p className="text-3xl font-bold text-primary font-tabular">
          {formatKRW(displayPrice)}
        </p>
        {hasDiscount && (
          <p className="text-sm text-cyan font-medium mt-1 font-tabular">
            {t("discountLabel", { pct: discountPct ?? 0, savings: formatKRW(savingsPerTicket) })}
          </p>
        )}
        <p className="text-2xs text-muted-foreground mt-0.5">{t("vatIncluded")}</p>
      </div>

      <div className="flex items-center justify-center">
        {isSoldOut ? (
          <span className="text-sm font-semibold text-red-500">{t("soldOut")}</span>
        ) : tier.remaining <= 10 ? (
          <span className="text-sm font-semibold text-red-500 animate-pulse">
            {t("seatsLeft", { count: tier.remaining ?? 0 })}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("seatsLeft", { count: tier.remaining ?? 0 })}
          </span>
        )}
      </div>

      {hasExternalSeats ? (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t("selectedSeats")}</p>
          <div className="flex flex-wrap gap-2">
            {selectedSeats.map((seat) => (
              <span
                key={seat.id}
                className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary"
              >
                {seat.label ||
                  t("seatLabel", { section: seat.section ?? "", row: seat.row_number ?? "", number: seat.seat_number ?? "" })}
              </span>
            ))}
          </div>
        </div>
      ) : externalQuantity === undefined ? (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t("quantity")}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={isSoldOut}
              className="size-10 rounded-full bg-muted hover:bg-muted-foreground/10 flex items-center justify-center font-bold text-foreground transition-colors disabled:opacity-50"
            >
              -
            </button>
            <span className="text-lg font-bold text-primary min-w-[2ch] text-center">
              {quantity}
            </span>
            <button
              type="button"
              onClick={() =>
                setQuantity((q) => Math.min(tier.max_group_size ?? 4, q + 1))
              }
              disabled={isSoldOut}
              className="size-10 rounded-full bg-muted hover:bg-muted-foreground/10 flex items-center justify-center font-bold text-foreground transition-colors disabled:opacity-50"
            >
              +
            </button>
            <span className="text-xs text-muted-foreground">
              {t("quantityMax", { max: tier.max_group_size ?? 4 })}
            </span>
          </div>
        </div>
      ) : null}

      <div className="bg-muted rounded-2xl p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("unitXQty")}</span>
          <span className="font-tabular">
            {formatKRW(displayPrice)} x {effectiveQuantity}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("fee")}</span>
          <span className="text-muted-foreground font-medium">
            {t("feeAtCheckout")}
          </span>
        </div>
        <div className="border-t border-border pt-2 flex justify-between items-baseline">
          <span className="font-semibold text-sm">{t("total")}</span>
          <div>
            <span className="font-bold text-primary font-tabular">
              {formatKRW(totalPrice)}
            </span>
            <span className="text-2xs text-muted-foreground ml-1">
              ({t("vatIncluded")})
            </span>
          </div>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {success ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-2xl p-5 text-center space-y-2"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            >
              <Check className="h-10 w-10 text-green-500 mx-auto" />
            </motion.div>
            <p className="font-bold text-green-700 dark:text-green-400">
              {t("successTitle", { ticket: orgLabels.ticketNoun ?? "" })}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                router.push("/mypage");
              }}
              className="rounded-full mt-2"
            >
              {t("viewMyTickets", { ticket: getOrganizerLabels(event.category).ticketNoun ?? "" })}
            </Button>
          </motion.div>
        ) : (
          <motion.div key="cta" exit={{ opacity: 0 }}>
            <Button
              type="button"
              onClick={handlePurchase}
              disabled={isSoldOut || isCreatingOrder}
              className="w-full rounded-full bg-primary hover:bg-primary/90 text-primary-foreground h-12 text-base font-semibold"
            >
              {isCreatingOrder ? (
                t("preparingOrder")
              ) : isSoldOut ? (
                t("soldOut")
              ) : (
                <span className="flex items-center gap-2">
                  <ShoppingCart className="h-5 w-5" />
                  {t("ctaBuy", { verb: orgLabels.ctaVerb ?? "" })}
                </span>
              )}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

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

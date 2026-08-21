"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { formatKRW } from "@pickket/lib";
import {
  Trophy,
  AlertCircle,
  Lightbulb,
  ChevronDown,
  CreditCard,
  Clock,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@pickket/ui";
import Link from "next/link";
import { getMyOrders, type OrderDetail } from "@pickket/lib/api";
import { usePaymentDeadline } from "@/hooks/usePaymentDeadline";

interface PersonalResultProps {
  myResult: {
    won: boolean;
    bid_price: number | null;
    fair_price: number | null;
    final_price: number | null;
    externality: number | null;
    order_id?: string | null;
  };
  eventId?: string;
}

function PriceCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="bg-background/60 dark:bg-background/10 rounded-2xl p-4 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-bold text-primary font-tabular">{value}</p>
      {note && <p className="text-2xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function PaymentBridge({
  orderId,
  deadline,
}: {
  orderId: string;
  deadline: string | null;
}) {
  const router = useRouter();
  const dl = usePaymentDeadline(deadline);
  const t = useTranslations("event.personalResult");

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
          {t("paymentPrompt")}
        </span>
      </div>

      {!dl.expired && (
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          <span
            className={`text-sm font-mono font-bold ${
              dl.isCritical
                ? "text-red-600 dark:text-red-400"
                : dl.isUrgent
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-emerald-600 dark:text-emerald-400"
            }`}
          >
            {dl.display}
          </span>
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t("timeRemaining")}
          </span>
        </div>
      )}

      <p className="text-xs text-amber-700 dark:text-amber-400">
        {t("paymentDeadlineWarning")}
      </p>

      <Button
        className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
        onClick={() => router.push(`/orders/${orderId}`)}
      >
        <CreditCard className="h-4 w-4 mr-2" />
        {t("proceedToPayment")}
      </Button>
    </motion.div>
  );
}

function WonResult({ myResult, eventId }: PersonalResultProps) {
  const [accordionOpen, setAccordionOpen] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<OrderDetail | null>(null);
  const t = useTranslations("event.personalResult");

  const savings =
    myResult.bid_price !== null && myResult.final_price !== null
      ? myResult.bid_price - myResult.final_price
      : 0;

  // Find the payment_required order for this event
  useEffect(() => {
    if (myResult.order_id) {
      // Already have order_id from myResult
      setPendingOrder({
        id: myResult.order_id,
        payment_deadline: null,
      } as OrderDetail);
      return;
    }
    if (!eventId) return;
    let cancelled = false;
    const findOrder = async () => {
      try {
        const res = await getMyOrders({
          status: "payment_required",
          event_id: eventId,
        });
        if (!cancelled && res.data.length > 0) {
          setPendingOrder(res.data[0]);
        }
      } catch {
        // No pending order found
      }
    };
    void findOrder();
    return () => {
      cancelled = true;
    };
  }, [myResult.order_id, eventId]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="bg-gradient-to-br from-green-50/90 to-emerald-50/90 dark:from-green-950/50 dark:to-emerald-950/50 backdrop-blur-xl rounded-2xl shadow-xl p-5 lg:p-6 space-y-5"
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
          <Trophy className="h-6 w-6 text-green-600 dark:text-green-400" />
        </div>
        <div>
          <h3 className="text-lg font-bold text-green-800 dark:text-green-300">
            {t("wonTitle")}
          </h3>
          {savings > 0 && (
            <p className="text-sm text-green-600 dark:text-green-400 font-tabular">
              {t("savedAmount", { amount: formatKRW(savings) })}
            </p>
          )}
        </div>
      </div>

      {/* Price cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <PriceCard
          label={t("fairPrice")}
          value={
            myResult.fair_price !== null ? formatKRW(myResult.fair_price) : "-"
          }
        />
        <PriceCard
          label={t("finalPrice")}
          value={
            myResult.final_price !== null
              ? formatKRW(myResult.final_price)
              : "-"
          }
        />
        <PriceCard
          label={t("savedAmountLabel")}
          value={
            myResult.externality !== null
              ? formatKRW(myResult.externality)
              : "-"
          }
        />
      </div>

      {/* Payment bridge: show when there's a pending order */}
      {pendingOrder && (
        <PaymentBridge
          orderId={pendingOrder.id}
          deadline={pendingOrder.payment_deadline}
        />
      )}

      {/* Savings note */}
      {savings > 0 && (
        <p className="text-sm text-green-700 dark:text-green-400 bg-green-100/60 dark:bg-green-900/30 rounded-2xl p-3">
          {t("apSavingsNote")}
        </p>
      )}

      {/* Transparency accordion */}
      <div>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setAccordionOpen(!accordionOpen)}
          className="w-full flex items-center justify-between px-0 hover:bg-transparent"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-green-800 dark:text-green-300">
            <Lightbulb className="h-4 w-4" />{t("whyThisPrice")}
          </span>
          <motion.div
            animate={{ rotate: accordionOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronDown className="h-4 w-4 text-green-700 dark:text-green-400" />
          </motion.div>
        </Button>

        <AnimatePresence>
          {accordionOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div className="bg-background/60 dark:bg-background/10 rounded-2xl p-4 mt-2 space-y-3 text-sm">
                {myResult.bid_price !== null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("myBidPrice")}</span>
                    <span className="font-medium text-foreground font-tabular">
                      {formatKRW(myResult.bid_price)}
                    </span>
                  </div>
                )}
                {myResult.fair_price !== null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("fairPrice")}</span>
                    <span className="font-medium text-foreground font-tabular">
                      {formatKRW(myResult.fair_price)}
                    </span>
                  </div>
                )}
                {myResult.externality !== null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("savedAmountLabel")}</span>
                    <span className="font-medium text-foreground font-tabular">
                      {formatKRW(myResult.externality)}
                    </span>
                  </div>
                )}

                <div className="border-t border-green-200 dark:border-green-800 pt-3">
                  {myResult.final_price !== null && (
                    <div className="flex justify-between font-bold">
                      <span className="text-foreground">{t("finalPrice")}</span>
                      <span className="text-primary font-tabular">
                        {formatKRW(myResult.final_price)}
                      </span>
                    </div>
                  )}
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed pt-2">
                  {t("apExplanation")}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function LostResult({ eventId }: { eventId?: string }) {
  const t = useTranslations("event.personalResult");
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="bg-gradient-to-br from-orange-50/90 to-amber-50/90 dark:from-orange-950/50 dark:to-amber-950/50 backdrop-blur-xl rounded-2xl shadow-xl p-5 lg:p-6 space-y-5"
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 rounded-full bg-orange-100 dark:bg-orange-900/40 flex items-center justify-center">
          <AlertCircle className="h-6 w-6 text-orange-600 dark:text-orange-400" />
        </div>
        <h3 className="text-lg font-bold text-orange-800 dark:text-orange-300">
          {t("lostTitle")}
        </h3>
      </div>

      {/* Tips */}
      <div className="bg-background/60 dark:bg-background/10 rounded-2xl p-4 space-y-3">
        <p className="text-sm font-semibold text-foreground">
          {t("tipsTitle")}
        </p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 rounded-full bg-orange-400 shrink-0" />
            {t("tipEarnAP")}
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 rounded-full bg-orange-400 shrink-0" />
            {t("tipInvestMoreAP")}
          </li>
        </ul>
      </div>

      {/* Resale link */}
      <Link
        href={eventId ? `/sell?event=${eventId}` : "/sell"}
        className="block text-center text-sm font-medium text-primary hover:underline"
      >
        {t("resaleLink")}
      </Link>
    </motion.div>
  );
}

export default function PersonalResult({
  myResult,
  eventId,
}: PersonalResultProps) {
  if (myResult.won) {
    return <WonResult myResult={myResult} eventId={eventId} />;
  }

  return <LostResult eventId={eventId} />;
}

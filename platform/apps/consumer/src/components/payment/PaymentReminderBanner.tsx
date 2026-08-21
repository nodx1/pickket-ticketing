"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { AlertCircle, CreditCard, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@pickket/store";
import { getMyOrders, type OrderDetail } from "@pickket/lib/api";
import { usePaymentDeadline } from "@/hooks/usePaymentDeadline";

function MostUrgentCountdown({ deadline }: { deadline: string }) {
  const dl = usePaymentDeadline(deadline);
  if (dl.expired) return null;
  return (
    <span className={`font-mono font-bold text-sm ${
      dl.isCritical ? "text-red-200" : dl.isUrgent ? "text-amber-200" : "text-white"
    }`}>
      {dl.display}
    </span>
  );
}

export default function PaymentReminderBanner() {
  const t = useTranslations("payment.reminderBanner");
  const { user, token } = useAuthStore();
  const router = useRouter();
  const [orders, setOrders] = useState<OrderDetail[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!user || !token || dismissed) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await getMyOrders({ status: "payment_required", limit: 10 });
        if (!cancelled) setOrders(res.data);
      } catch {
        // ignore
      }
    };
    void check();
    // Recheck every 2 minutes
    const interval = setInterval(check, 120_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [user, token, dismissed]);

  if (!user || orders.length === 0 || dismissed) return null;

  // Find most urgent deadline
  const withDeadline = orders
    .filter((o) => o.payment_deadline)
    .sort((a, b) =>
      new Date(a.payment_deadline!).getTime() - new Date(b.payment_deadline!).getTime(),
    );
  const mostUrgent = withDeadline[0];

  const handleClick = () => {
    if (orders.length === 1) {
      router.push(`/orders/${orders[0].id}`);
    } else {
      router.push("/orders?tab=payment_required");
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        className="bg-amber-600 dark:bg-amber-700 text-white"
      >
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <button
            onClick={handleClick}
            className="flex items-center gap-2 flex-1 min-w-0"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="text-sm font-medium truncate">
              {t("pendingOrdersCount", { count: orders.length })}
            </span>
            {mostUrgent?.payment_deadline && (
              <MostUrgentCountdown deadline={mostUrgent.payment_deadline} />
            )}
          </button>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleClick}
              className="flex items-center gap-1 px-3 py-2 rounded-full bg-white/20 hover:bg-white/30 text-sm font-medium transition-colors"
            >
              <CreditCard className="h-3.5 w-3.5" />
              {t("payNow")}
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="p-2 rounded-full hover:bg-white/20 transition-colors"
              aria-label={t("dismiss")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import {
  ShoppingCart,
  Clock,
  CreditCard,
  ChevronRight,
  Ticket,
} from "lucide-react";
import { Badge, Button } from "@pickket/ui";
import { getMyOrders, getEvent, type OrderDetail } from "@pickket/lib/api";
import { formatKRW, formatDateShort } from "@pickket/lib";
import { usePaymentDeadline } from "@/hooks/usePaymentDeadline";
import { useAuthStore } from "@pickket/store";
import { CARD } from "@/lib/styles";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";

type FilterTab = "all" | "payment_required" | "confirmed" | "cancelled";

const FILTER_TAB_KEYS: FilterTab[] = [
  "all",
  "payment_required",
  "confirmed",
  "cancelled",
];

function statusToApiFilter(tab: FilterTab): string | undefined {
  if (tab === "all") return undefined;
  // 'cancelled' tab includes cancelled + expired + refunded — no single server-side
  // status covers all three, so we fetch all orders with a larger limit and filter client-side.
  if (tab === "cancelled") return undefined;
  return tab;
}

function limitForTab(tab: FilterTab): number {
  // cancelled/refunded/expired orders may be sparse among the last 100 records.
  // Use a larger page for the cancelled tab to reduce truncation risk.
  return tab === "cancelled" ? 500 : 100;
}

const STATUS_CLS: Record<string, string> = {
  pending: "bg-white/10 text-muted-foreground",
  payment_required: "bg-amber-600/10 text-amber-600 dark:text-amber-400",
  authorized: "bg-primary/10 text-primary/70",
  paid: "bg-blue-500/10 text-blue-400",
  confirmed: "bg-emerald-600/10 text-emerald-600 dark:text-emerald-400",
  cancelled: "bg-white/10 text-muted-foreground",
  expired: "bg-red-600/10 text-red-600 dark:text-red-400",
  refunded: "bg-orange-500/10 text-orange-400",
};

function DeadlineCountdown({
  deadline,
  expiredLabel,
}: {
  deadline: string;
  expiredLabel: string;
}) {
  const { display, isUrgent, isCritical, expired } =
    usePaymentDeadline(deadline);
  if (expired)
    return (
      <span className="text-xs text-red-600 dark:text-red-400 font-medium">{expiredLabel}</span>
    );
  return (
    <span
      className={`text-xs font-mono font-semibold ${
        isCritical
          ? "text-red-600 dark:text-red-400"
          : isUrgent
            ? "text-amber-600 dark:text-amber-400"
            : "text-emerald-600 dark:text-emerald-400"
      }`}
    >
      {display}
    </span>
  );
}

function OrderCard({
  order,
  eventTitle,
  onClick,
  t,
}: {
  order: OrderDetail;
  eventTitle: string;
  onClick: () => void;
  t: (key: string) => string;
}) {
  const statusLabel = t(`status_${order.status}`) || order.status;
  const statusCls =
    STATUS_CLS[order.status] ?? "bg-white/10 text-muted-foreground";
  const showDeadline =
    order.status === "payment_required" && order.payment_deadline;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`${CARD.compact} shadow-sm cursor-pointer hover:shadow-md transition-shadow`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate text-foreground">
            {eventTitle}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatDateShort(order.created_at)} · {order.quantity}
            {t("quantity_suffix")}
          </p>
        </div>
        <Badge className={`rounded-full text-2xs shrink-0 ${statusCls}`}>
          {statusLabel}
        </Badge>
      </div>

      <div className="flex items-center justify-between mt-3 gap-2">
        <span className="text-base font-bold font-tabular text-foreground">
          {formatKRW(order.total_amount)}
        </span>
        <div className="flex items-center gap-2">
          {showDeadline && (
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <DeadlineCountdown
                deadline={order.payment_deadline!}
                expiredLabel={t("deadline_expired")}
              />
            </div>
          )}
          {order.status === "payment_required" ? (
            <Button
              size="sm"
              className="h-8 rounded-full px-4 bg-primary hover:bg-primary/90 text-white text-xs font-semibold shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
            >
              <CreditCard className="h-3 w-3 mr-1" />
              {t("pay_now")}
            </Button>
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function OrderSkeleton() {
  return (
    <div className={`${CARD.compact} animate-pulse space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-2">
          <div className="h-4 w-3/4 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted" />
        </div>
        <div className="h-5 w-16 rounded-full bg-muted" />
      </div>
      <div className="flex items-center justify-between">
        <div className="h-5 w-24 rounded bg-muted" />
        <div className="h-4 w-4 rounded bg-muted" />
      </div>
    </div>
  );
}

export default function OrdersTab() {
  const router = useRouter();
  const { user } = useAuthStore();
  const t = useTranslations("orders");
  const [filterTab, setFilterTab] = useState<FilterTab>("all");

  const { data: ordersData, isLoading: loading } = useQuery({
    queryKey: ["orders", filterTab],
    queryFn: async () => {
      const status = statusToApiFilter(filterTab);
      const res = await getMyOrders({ status, limit: limitForTab(filterTab) });
      let list = res.data;

      if (filterTab === "cancelled") {
        list = list.filter((o: OrderDetail) =>
          ["cancelled", "expired", "refunded"].includes(o.status),
        );
      }

      const uniqueEventIds = [
        ...new Set(list.map((o: OrderDetail) => o.event_id)),
      ];
      const titles: Record<string, string> = {};
      await Promise.all(
        uniqueEventIds.map(async (eid) => {
          try {
            const ev = await getEvent(eid);
            titles[eid] = ev.data?.title || t("event_fallback");
          } catch {
            titles[eid] = t("event_fallback");
          }
        }),
      );

      return { orders: list, eventTitles: titles };
    },
    enabled: !!user,
    refetchInterval: 30_000,
  });

  const orders = ordersData?.orders ?? [];
  const eventTitles = ordersData?.eventTitles ?? {};

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold flex items-center gap-2">
        <ShoppingCart className="h-5 w-5 text-primary" />
        주문 내역
      </h2>

      {/* Filter tabs */}
      <div className="flex gap-2 overflow-x-auto scrollbar-hide">
        {FILTER_TAB_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => setFilterTab(key)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
              filterTab === key
                ? "bg-primary text-white"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`filter_${key}`)}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <OrderSkeleton key={i} />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 space-y-4">
          <Ticket className="h-12 w-12 mx-auto text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t("no_orders")}</p>
          <Button
            variant="outline"
            className="rounded-full"
            onClick={() => router.push("/")}
          >
            {t("browse_events")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order, i) => (
            <motion.div
              key={order.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <OrderCard
                order={order}
                eventTitle={eventTitles[order.event_id] || t("event_fallback")}
                t={t}
                onClick={() => router.push(`/orders/${order.id}`)}
              />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import {
  CheckCircle2,
  Clock3,
  Ticket as TicketIcon,
  AlertTriangle,
  RefreshCw,
  ShieldQuestion,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge, Button } from "@pickket/ui";
import { formatDateShort, formatKRW } from "@pickket/lib";
import {
  getGuestOrder,
  type GuestOrderView,
} from "@pickket/lib/api";
import { readGuestViewToken, persistGuestViewToken } from "@/hooks/useGuestBooking";
import { GuestRefundPanel } from "./GuestRefundPanel";
import { GuestClaimPanel } from "./GuestClaimPanel";

interface GuestOrderClientProps {
  locale: string;
  orderId: string;
  urlToken: string | null;
}

const STATUS_CLS: Record<string, string> = {
  payment_required: "bg-amber-600/10 text-amber-600 dark:text-amber-400",
  authorized: "bg-primary/10 text-primary",
  paid: "bg-blue-500/10 text-blue-500",
  confirmed: "bg-emerald-600/10 text-emerald-600 dark:text-emerald-400",
  cancelled: "bg-muted text-content-muted",
  expired: "bg-red-600/10 text-red-600 dark:text-red-400",
  refunded: "bg-orange-500/10 text-orange-500",
  partially_refunded: "bg-orange-500/10 text-orange-500",
};

export function GuestOrderClient({
  locale,
  orderId,
  urlToken,
}: GuestOrderClientProps) {
  const t = useTranslations("guest.order");
  const router = useRouter();

  // next-intl 은 키 부재 시 예외를 던지므로, 미정의 status/ticketStatus 는 raw 값으로 폴백한다.
  const statusLabel = (status: string) =>
    t.has(`status_${status}`) ? t(`status_${status}`) : status;
  const ticketStatusLabel = (status: string) =>
    t.has(`ticketStatus_${status}`) ? t(`ticketStatus_${status}`) : status;

  const [viewToken, setViewToken] = useState<string | null>(null);
  const [data, setData] = useState<GuestOrderView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // view_token 확정: URL ?token= 우선, 없으면 sessionStorage. URL 로 온 경우 세션에도 보관.
  useEffect(() => {
    if (urlToken) {
      setViewToken(urlToken);
      // 만료값 미상 → 보수적으로 세션 보관(만료는 서버가 최종 판정).
      persistGuestViewToken(
        orderId,
        urlToken,
        new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      );
      return;
    }
    setViewToken(readGuestViewToken(orderId));
  }, [urlToken, orderId]);

  const fetchOrder = useCallback(async () => {
    if (!viewToken) {
      setLoading(false);
      setError(t("errorNoToken"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getGuestOrder(orderId, viewToken);
      setData(res.data);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("errorLoad");
      setError(detail);
    } finally {
      setLoading(false);
    }
  }, [orderId, viewToken, t]);

  useEffect(() => {
    if (viewToken !== null || urlToken === null) void fetchOrder();
  }, [viewToken, urlToken, fetchOrder]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background mx-auto max-w-2xl px-5 pt-20 pb-6">
        <div className="h-40 rounded-2xl bg-muted animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background mx-auto max-w-2xl px-5 pt-20 pb-6">
        <div className="rounded-2xl bg-card border border-border p-6 text-center space-y-3">
          <ShieldQuestion className="h-10 w-10 text-content-muted mx-auto" />
          <p className="text-sm text-content-subtle">
            {error ?? t("errorLoad")}
          </p>
          <p className="text-xs text-content-muted">{t("errorTokenHint")}</p>
          <Button
            variant="outline"
            onClick={() => router.push(`/${locale}`)}
            className="rounded-full"
          >
            {t("goHome")}
          </Button>
        </div>
      </div>
    );
  }

  const { order, tickets } = data;
  const badgeCls = STATUS_CLS[order.status] ?? "bg-muted text-content-muted";
  const isRefundable = order.status === "confirmed" || order.status === "paid";
  const isRefunded =
    order.status === "refunded" || order.status === "partially_refunded";
  const anyCheckedIn = tickets.some((tk) => tk.checked_in);

  return (
    <motion.div
      className="min-h-screen bg-background mx-auto max-w-2xl px-5 pt-20 pb-6 space-y-5"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      {/* 주문 요약 */}
      <div className="rounded-2xl bg-card border border-border p-5 lg:p-6 shadow-sm space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-content-muted">{t("orderId")}</p>
            <p className="text-sm font-medium break-all text-content-default">
              {order.order_id}
            </p>
          </div>
          <Badge className={`rounded-full shrink-0 ${badgeCls}`}>
            {statusLabel(order.status)}
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-muted/60 p-3">
            <p className="text-xs text-content-muted">{t("amount")}</p>
            <p className="font-semibold font-tabular text-content-default">
              {formatKRW(order.total_amount)}
            </p>
          </div>
          <div className="rounded-xl bg-muted/60 p-3">
            <p className="text-xs text-content-muted">{t("orderDate")}</p>
            <p className="font-semibold text-content-default">
              {order.created_at ? formatDateShort(order.created_at) : "-"}
            </p>
          </div>
        </div>

        {/* 구매자(마스킹) */}
        <div className="rounded-xl border border-border p-3 space-y-1.5">
          <p className="text-xs font-semibold text-content-subtle">
            {t("buyer")}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
            <span className="text-content-default">
              {order.buyer_name_masked || "-"}
            </span>
            <span className="text-content-muted break-all">
              {order.buyer_email_masked || "-"}
            </span>
            <span className="text-content-muted">
              {order.buyer_phone_masked || "-"}
            </span>
          </div>
          <p className="text-2xs text-content-muted">{t("maskedNote")}</p>
        </div>

        {isRefunded && order.total_refunded > 0 && (
          <div className="rounded-xl bg-orange-500/10 border border-orange-500/20 p-4 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-orange-500 shrink-0" />
            <span className="text-sm text-orange-500">
              {t("refundedAmount")}{" "}
              <span className="font-bold font-tabular">
                {formatKRW(order.total_refunded)}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* 티켓 목록 */}
      <div className="rounded-2xl bg-card border border-border p-5 shadow-sm space-y-3">
        <p className="text-sm font-semibold text-content-default flex items-center gap-2">
          <TicketIcon className="h-4 w-4 text-primary" />
          {t("tickets", { count: tickets.length })}
        </p>
        {tickets.length === 0 ? (
          <p className="text-sm text-content-muted">{t("noTickets")}</p>
        ) : (
          <ul className="space-y-2">
            {tickets.map((tk) => (
              <li
                key={tk.ticket_id}
                className="flex items-center justify-between rounded-xl bg-muted/60 px-3 py-2.5 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {tk.checked_in ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <Clock3 className="h-4 w-4 text-content-muted shrink-0" />
                  )}
                  <span className="text-content-default truncate">
                    {ticketStatusLabel(tk.status)}
                  </span>
                </div>
                {tk.admission_day && (
                  <span className="text-xs text-content-muted shrink-0">
                    {formatDateShort(tk.admission_day)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 환불 */}
      {isRefundable && viewToken && (
        <GuestRefundPanel
          orderId={orderId}
          viewToken={viewToken}
          checkedIn={anyCheckedIn}
          onRefunded={() => void fetchOrder()}
        />
      )}

      {/* 회원 승격 안내 */}
      {!isRefunded && viewToken && (
        <GuestClaimPanel
          locale={locale}
          orderId={orderId}
          viewToken={viewToken}
          checkedIn={anyCheckedIn}
        />
      )}

      {/* 안내 */}
      <div className="rounded-2xl border border-border bg-muted/40 p-4 flex items-start gap-2.5">
        <AlertTriangle className="h-4 w-4 text-content-muted shrink-0 mt-0.5" />
        <p className="text-xs text-content-muted">{t("bookmarkNote")}</p>
      </div>

      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchOrder()}
          className="rounded-full text-content-muted"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          {t("refresh")}
        </Button>
      </div>
    </motion.div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Clock3,
  Shield,
  XCircle,
  CreditCard,
  AlertTriangle,
  Timer,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@pickket/ui";
import { Button } from "@pickket/ui";
import PaymentStatus from "@/components/payment/PaymentStatus";
import ReceiptDownload from "@/components/payment/ReceiptDownload";
import OrderConfirmationModal from "@/components/payment/OrderConfirmationModal";
import { freeCancelUntilDays } from "@/app/[locale]/events/[id]/_components/cancellationSchedule";
import PaymentCompleteModal from "@/components/payment/PaymentCompleteModal";
import PaymentErrorModal from "@/components/payment/PaymentErrorModal";
import RefundRequestModal from "@/components/payment/RefundRequestModal";
import { formatDateShort, formatKRW } from "@pickket/lib";
import {
  getEvent,
  getOrder,
  voidOrder,
} from "@pickket/lib/api";
import { usePaymentDeadline } from "@/hooks/usePaymentDeadline";
import { useOrderPayment } from "@/hooks/useOrderPayment";
import type { OrderInfo } from "@/hooks/usePayment";
import { useAuthStore } from "@pickket/store";
import { useAuthReady } from "@/providers/AuthProvider";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";

type ApiError = { response?: { data?: { detail?: string } } };

const STATUS_BADGE_CLS: Record<
  string,
  { badgeClass: string; icon: typeof Shield }
> = {
  pending: {
    badgeClass: "bg-white/10 text-muted-foreground",
    icon: Clock3,
  },
  payment_required: {
    badgeClass: "bg-amber-600/10 text-amber-600 dark:text-amber-400",
    icon: CreditCard,
  },
  authorized: {
    badgeClass: "bg-primary/10 text-primary/70",
    icon: Shield,
  },
  paid: { badgeClass: "bg-blue-500/10 text-blue-400", icon: CheckCircle2 },
  confirmed: {
    badgeClass: "bg-emerald-600/10 text-emerald-600 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  cancelled: {
    badgeClass: "bg-white/10 text-muted-foreground",
    icon: XCircle,
  },
  expired: {
    badgeClass: "bg-red-600/10 text-red-600 dark:text-red-400",
    icon: AlertTriangle,
  },
  refunded: { badgeClass: "bg-orange-500/10 text-orange-400", icon: XCircle },
};

/* ---------- Confetti CSS keyframes ---------- */
const confettiStyles = `
@keyframes confetti-fall {
  0% { transform: translateY(-100vh) rotate(0deg); opacity: 1; }
  100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
}
@keyframes confetti-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(12px); }
  75% { transform: translateX(-12px); }
}
`;

function ConfettiOverlay() {
  const colors = [
    "#ff6b6b",
    "#ffd93d",
    "#6bcb77",
    "#4d96ff",
    "#ff6fd8",
    "#845ec2",
  ];
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      <style>{confettiStyles}</style>
      {Array.from({ length: 50 }).map((_, i) => {
        const color = colors[i % colors.length];
        const left = Math.random() * 100;
        const delay = Math.random() * 3;
        const duration = 2 + Math.random() * 3;
        const size = 6 + Math.random() * 8;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${left}%`,
              top: 0,
              width: `${size}px`,
              height: `${size}px`,
              backgroundColor: color,
              borderRadius: Math.random() > 0.5 ? "50%" : "2px",
              animation: `confetti-fall ${duration}s ease-in ${delay}s forwards, confetti-shake ${duration * 0.5}s ease-in-out ${delay}s infinite`,
            }}
          />
        );
      })}
    </div>
  );
}

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const ready = useAuthReady();
  const t = useTranslations("orders");
  const orderId = params.id as string;

  useEffect(() => {
    // 세션 복원(AuthProvider) 완료 전에는 판단 보류 — store 기본값 user=null 로
    // 로그인 사용자를 결제 직후 /auth 로 오리다이렉트하는 레이스 방지.
    if (ready && user === null) {
      router.replace("/auth");
    }
  }, [ready, user, router]);

  const queryClient = useQueryClient();
  const [showConfetti, setShowConfetti] = useState(false);
  const confettiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confettiTimeoutRef.current) clearTimeout(confettiTimeoutRef.current);
    };
  }, []);
  const [actionLoading, setActionLoading] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

  const { data: orderData, isLoading: loading } = useQuery({
    queryKey: ["orders", orderId],
    queryFn: async () => {
      const res = await getOrder(orderId);
      const orderResult = res.data;

      // Show confetti for confirmed RESALE_BUY orders
      if (
        orderResult.status === "confirmed" &&
        orderResult.order_type === "RESALE_BUY"
      ) {
        setShowConfetti(true);
        const timeout = setTimeout(() => setShowConfetti(false), 5000);
        confettiTimeoutRef.current = timeout;
      }

      let eventTitle = t("event_fallback");
      // 주문서의 「등급」·환불 안내는 행사 정보에서 채운다(주문 응답엔 등급 id 만 있다 — 예전엔 order_type
      // 「purchase」가 등급 자리에 그대로 찍혔다).
      let tierName: string | null = null;
      let freeCancelDays: number | null = null;
      // 나이스 결제수단 게이팅(C2) — 이벤트 allowed_pay_methods 를 결제 훅에 전달.
      let allowedPayMethods: string[] | null = null;
      try {
        const eventRes = await getEvent(orderResult.event_id);
        eventTitle = eventRes.data?.title || t("event_fallback");
        allowedPayMethods = eventRes.data?.allowed_pay_methods ?? null;
        tierName = eventRes.data?.seat_tiers?.find((x: { id: string }) => x.id === orderResult.tier_id)?.name ?? null;
        freeCancelDays = freeCancelUntilDays(eventRes.data?.cancellation_fee_tiers);
      } catch {
        // fallback already set
      }

      return { order: orderResult, eventTitle, allowedPayMethods, tierName, freeCancelDays };
    },
    refetchInterval: 30_000, // 30-second polling
  });

  const order = orderData?.order ?? null;
  const eventTitle = orderData?.eventTitle ?? "";
  const allowedPayMethods = orderData?.allowedPayMethods ?? null;

  const fetchOrder = () =>
    queryClient.invalidateQueries({ queryKey: ["orders", orderId] });

  // Payment deadline
  const deadline = usePaymentDeadline(
    order?.status === "payment_required" ? order.payment_deadline : null,
    () => void fetchOrder(),
  );

  // Order payment flow (나이스 결제수단 게이팅: 이벤트 allowed_pay_methods 주입)
  const payment = useOrderPayment(() => fetchOrder(), allowedPayMethods);

  const handlePayClick = () => {
    if (!order) return;
    payment.startPayment(order, eventTitle);
  };

  const handleVoid = async () => {
    if (!order) return;
    setActionLoading(true);
    try {
      await voidOrder(order.id, "user_cancelled_authorization");
      toast.success(t("cancel_success"));
      await fetchOrder();
    } catch (err: unknown) {
      const message =
        (err as ApiError)?.response?.data?.detail || t("cancel_error");
      toast.error(message);
    } finally {
      setActionLoading(false);
    }
  };

  const meta = useMemo(() => {
    const status = order?.status || "";
    const cls = STATUS_BADGE_CLS[status] ?? {
      badgeClass: "bg-white/10 text-muted-foreground",
      icon: Clock3,
    };
    const label = status ? t(`status_${status}`) || status : status;
    return { label, ...cls };
  }, [order?.status, t]);
  const MetaIcon = meta.icon;

  // Build OrderInfo for the confirmation modal
  const orderInfoForModal: OrderInfo | null = order
    ? {
        eventTitle,
        tierName: orderData?.tierName || t("ticket_fallback"),
        unitPrice: order.unit_price,
        quantity: order.quantity,
        fees: { platformFee: 0, organizerShare: 0 },
        totalAmount: order.total_amount,
      }
    : null;

  if (loading) {
    return (
      <div className="bg-background min-h-screen mx-auto max-w-3xl px-5 pt-20 pb-5 lg:px-6 lg:pb-6">
        <div className="h-40 rounded-2xl bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="bg-background min-h-screen mx-auto max-w-3xl px-5 pt-20 pb-5 lg:px-6 lg:pb-6">
        <div className="rounded-2xl bg-card p-6 shadow-lg text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("order_not_found")}
          </p>
          <Button onClick={() => router.push("/mypage")}>
            {t("go_mypage")}
          </Button>
        </div>
      </div>
    );
  }

  const timeline = [
    {
      key: "created",
      label: t("timeline_created"),
      done: Boolean(order.created_at),
      time: order.created_at,
    },
    {
      key: "payment",
      label: t("timeline_payment"),
      done:
        Boolean(order.pg_approved_at) ||
        ["paid", "authorized", "confirmed"].includes(order.status),
      time: order.pg_approved_at || order.payment_started_at,
    },
    {
      key: "authorized",
      label: t("timeline_authorized"),
      done: Boolean(order.authorized_at) || order.status === "confirmed",
      time: order.authorized_at,
    },
    {
      key: "captured",
      label: t("timeline_captured"),
      done: Boolean(order.captured_at) || order.status === "confirmed",
      time: order.captured_at,
    },
  ];

  return (
    <motion.div
      className="bg-background min-h-screen mx-auto max-w-3xl px-5 pt-20 pb-5 lg:px-6 lg:pb-6 space-y-6"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="rounded-2xl bg-card p-5 lg:p-6 shadow-lg space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">{t("order_id")}</p>
            <p className="text-sm font-medium break-all text-foreground">
              {order.id}
            </p>
            <p className="text-lg font-semibold mt-2 text-foreground">
              {eventTitle}
            </p>
          </div>
          <Badge className={`rounded-full ${meta.badgeClass}`}>
            {meta.label}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-white/5 p-3">
            <p className="text-xs text-muted-foreground">
              {t("payment_amount")}
            </p>
            <p className="font-semibold font-tabular text-foreground">
              {formatKRW(order.total_amount)}
            </p>
          </div>
          <div className="rounded-xl bg-white/5 p-3">
            <p className="text-xs text-muted-foreground">{t("order_date")}</p>
            <p className="font-semibold text-foreground">
              {formatDateShort(order.created_at)}
            </p>
          </div>
        </div>

        {/* Payment deadline countdown for payment_required */}
        {order.status === "payment_required" && !deadline.expired && (
          <div className="rounded-xl bg-amber-600/10 border border-amber-600/20 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <span className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                {t("payment_deadline")}
              </span>
            </div>
            <div
              className={`text-2xl font-bold font-mono ${
                deadline.isCritical
                  ? "text-red-600 dark:text-red-400"
                  : deadline.isUrgent
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {deadline.display}
            </div>
            <p className="text-xs text-amber-600 dark:text-amber-400/80">{t("deadline_warning")}</p>
          </div>
        )}

        {/* Expired notice */}
        {order.status === "expired" && (
          <div className="rounded-xl bg-red-600/10 border border-red-600/20 p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
              <span className="text-sm font-semibold text-red-600 dark:text-red-400">
                {t("expired_title")}
              </span>
            </div>
            <p className="text-xs text-red-600 dark:text-red-400/80 mt-1">{t("expired_desc")}</p>
          </div>
        )}

        {/* Refunded notice — show refund amount and date */}
        {order.status === "refunded" && (
          <div className="rounded-xl bg-orange-500/10 border border-orange-500/20 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-orange-500" />
              <span className="text-sm font-semibold text-orange-500">
                {t("refunded_title")}
              </span>
            </div>
            {order.refund_amount != null && (
              <p className="text-sm text-orange-500/90">
                {t("refunded_amount")}{" "}
                <span className="font-bold font-tabular">
                  {formatKRW(order.refund_amount)}
                </span>
              </p>
            )}
            {order.refunded_at && (
              <p className="text-xs text-orange-500/70">
                {t("refunded_at")} {formatDateShort(order.refunded_at)}
              </p>
            )}
          </div>
        )}

        {/* Timeline */}
        <div className="rounded-2xl border border-white/[0.08] p-4 space-y-3">
          <p className="text-sm font-semibold text-foreground">
            {t("timeline")}
          </p>
          {timeline.map((step) => (
            <div
              key={step.key}
              className="flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-2">
                {step.done ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Clock3 className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="text-foreground">{step.label}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {step.time ? formatDateShort(step.time) : "-"}
              </span>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          {order.status === "payment_required" && !deadline.expired && (
            <Button
              className="bg-primary hover:bg-primary/90 text-white"
              onClick={handlePayClick}
            >
              <CreditCard className="h-4 w-4 mr-2" />
              {t("pay_now")}
            </Button>
          )}

          {(order.status === "authorized" || order.status === "confirmed") && (
            <Button variant="outline" onClick={() => setStatusOpen(true)}>
              {t("view_payment_status")}
            </Button>
          )}

          {order.status === "authorized" && (
            <Button
              variant="outline"
              className="text-red-600 dark:text-red-400 border-red-600/20 hover:bg-red-600/10"
              onClick={handleVoid}
              disabled={actionLoading}
            >
              {actionLoading ? t("cancelling") : t("cancel_reservation")}
            </Button>
          )}

          {(order.status === "confirmed" || order.status === "paid") && (
            <ReceiptDownload orderId={orderId} />
          )}

          {(order.status === "confirmed" || order.status === "paid") && (
            <Button
              variant="outline"
              className="text-orange-500 border-orange-500/30 hover:bg-orange-500/10"
              onClick={() => setRefundOpen(true)}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              환불 신청
            </Button>
          )}
        </div>

        {order.payment_failed_reason && (
          <div className="rounded-xl border border-red-500/20 bg-red-600/10 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-red-500/20 p-2 shrink-0">
                <CreditCard className="h-4 w-4 text-red-600 dark:text-red-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-1">
                  결제 실패
                </p>
                <p className="text-xs text-red-600 dark:text-red-400/80">
                  {order.payment_failed_reason}
                </p>
              </div>
            </div>
            {order.status === "payment_required" && !deadline.expired && (
              <Button
                className="mt-3 w-full bg-red-600 hover:bg-red-700 text-white"
                onClick={handlePayClick}
                size="sm"
              >
                <CreditCard className="h-4 w-4 mr-2" />
                다시 결제하기
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Payment status dialog */}
      {(order.status === "authorized" || order.status === "confirmed") && (
        <PaymentStatus
          open={statusOpen}
          status={order.status === "authorized" ? "authorized" : "captured"}
          amount={order.total_amount}
          eventTitle={eventTitle}
          onClose={() => setStatusOpen(false)}
        />
      )}

      {/* Order Payment Modals */}
      {orderInfoForModal &&
        (payment.phase === "confirming" || payment.phase === "processing") && (
          <OrderConfirmationModal
            open
            phase={payment.phase === "processing" ? "processing" : "confirming"}
            orderInfo={orderInfoForModal}
            agreed={payment.agreed}
            widgetReady={payment.widgetReady}
            showNiceMethods={payment.showNiceMethods}
            niceMethods={payment.niceMethods}
            niceMethod={payment.niceMethod}
            onNiceMethodChange={payment.setNiceMethod}
            niceCardOnly={payment.niceCardOnly}
            provider={payment.provider}
            onCancelProcessing={payment.cancelProcessing}
            freeCancelUntilDays={orderData?.freeCancelDays ?? null}
            onAgreedChange={payment.setAgreed}
            onConfirm={payment.executePayment}
            onClose={payment.closeModal}
          />
        )}

      {orderInfoForModal && payment.phase === "complete" && (
        <PaymentCompleteModal
          open
          paymentResult={{
            success: true,
            paymentId: order.payment_id || "completed",
            orderId: order.id,
            amount: order.total_amount,
            payMethod: payment.selectedPayMethod,
            paidAt: new Date().toISOString(),
          }}
          orderInfo={orderInfoForModal}
          onViewTickets={() => router.push("/mypage?tab=tickets")}
          onBrowseEvents={() => router.push("/")}
          onClose={payment.closeModal}
        />
      )}

      {payment.phase === "error" && payment.errorMessage && (
        <PaymentErrorModal
          open
          errorMessage={payment.errorMessage}
          onRetry={payment.retryPayment}
          onChangeMethod={payment.retryPayment}
          onClose={payment.closeModal}
        />
      )}

      <RefundRequestModal
        open={refundOpen}
        order={order}
        onClose={() => setRefundOpen(false)}
        onSuccess={() => {
          setRefundOpen(false);
          void fetchOrder();
        }}
      />

      {/* Confetti for confirmed RESALE_BUY */}
      {showConfetti && <ConfettiOverlay />}
      {showConfetti &&
        order.order_type === "RESALE_BUY" &&
        order.status === "confirmed" && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-2xl bg-gradient-to-r from-emerald-600/10 to-cyan-500/10 border border-emerald-600/20 p-6 text-center space-y-2"
          >
            <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {t("confetti_congrats")}
            </p>
            <p className="text-sm text-emerald-600 dark:text-emerald-400/80">
              {t("confetti_resale_message")}
            </p>
          </motion.div>
        )}

      <div className="text-xs text-muted-foreground inline-flex items-center gap-1">
        <MetaIcon className="h-3.5 w-3.5" />
        {t("current_status")} {meta.label}
      </div>
    </motion.div>
  );
}

"use client";

import { createPortal } from "react-dom";
import { CheckCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatKRW } from "@pickket/lib";
import { PAY_METHOD_LABELS, type PayMethod } from "@/lib/toss";
import type { OrderInfo } from "@/hooks/usePayment";

interface PaymentResult {
  paymentId: string;
  amount: number;
  payMethod: PayMethod;
  paidAt: string;
}

interface PaymentCompleteInlineProps {
  open: boolean;
  orderInfo: OrderInfo;
  paymentResult: PaymentResult;
  onViewTickets: () => void;
  onBrowseEvents: () => void;
}

export default function PaymentCompleteInline({
  open,
  orderInfo,
  paymentResult,
  onViewTickets,
  onBrowseEvents,
}: PaymentCompleteInlineProps) {
  const t = useTranslations("payment.completeInline");

  if (!open || typeof window === "undefined") return null;

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
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.5)",
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 448,
          maxHeight: "90vh",
          overflowY: "auto",
          backgroundColor: "var(--background, #fff)",
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 12,
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
        }}
      >
        <div className="p-6 space-y-5">
          {/* 성공 아이콘 */}
          <div className="text-center">
            <div className="inline-flex h-16 w-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 items-center justify-center mb-3">
              <CheckCircle className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="text-xl font-bold text-foreground">{t("title")}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {orderInfo.eventTitle}
            </p>
          </div>

          {/* 결제 정보 */}
          <div className="rounded-xl bg-muted p-4 space-y-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("amountLabel")}</span>
              <span className="text-lg font-bold font-tabular text-primary">
                {formatKRW(paymentResult.amount)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("transactionIdLabel")}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {paymentResult.paymentId}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("payMethodLabel")}</span>
              <span className="text-foreground">
                {PAY_METHOD_LABELS[paymentResult.payMethod]}
              </span>
            </div>
          </div>

          {/* CTA 버튼 */}
          <div className="flex gap-3">
            <button
              onClick={onViewTickets}
              className="flex-1 h-11 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm transition-colors"
            >
              {t("viewTicketsButton")}
            </button>
            <button
              onClick={onBrowseEvents}
              className="flex-1 h-11 rounded-full border border-border bg-background hover:bg-muted text-foreground font-semibold text-sm transition-colors"
            >
              {t("browseEventsButton")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

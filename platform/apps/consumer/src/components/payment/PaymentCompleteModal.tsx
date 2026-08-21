"use client";

import { motion, AnimatePresence } from "motion/react";
import { CheckCircle, Copy, Phone, Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { Button } from "@pickket/ui";
import { formatKRW, formatDate } from "@pickket/lib";
import { PAY_METHOD_LABELS, type PaymentResponse } from "@/lib/toss";
import type { OrderInfo } from "@/hooks/usePayment";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface Props {
  open: boolean;
  paymentResult: PaymentResponse;
  orderInfo: OrderInfo;
  onViewTickets: () => void;
  onBrowseEvents: () => void;
  onClose: () => void;
  ticketNoun?: string;
  onGoToCommunity?: () => void;
}

export default function PaymentCompleteModal({
  open,
  paymentResult,
  orderInfo,
  onViewTickets,
  onBrowseEvents,
  onClose,
  ticketNoun = "티켓",
  onGoToCommunity,
}: Props) {
  const t = useTranslations("payment.completeModal");
  const copyTxId = async () => {
    try {
      await navigator.clipboard.writeText(paymentResult.paymentId);
      toast.success(t("copySuccess"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description")}
          </DialogDescription>
        </DialogHeader>
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="space-y-5 pt-4"
          >
            {/* Success icon */}
            <div className="text-center">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 200, delay: 0.1 }}
                className="inline-flex h-16 w-16 rounded-full bg-cyan/10 items-center justify-center mb-3"
              >
                <CheckCircle className="h-8 w-8 text-cyan" />
              </motion.div>
              <h2 className="text-xl font-bold text-foreground">{t("title")}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {orderInfo.eventTitle}
              </p>
            </div>

            {/* 결제 정보 */}
            <div className="rounded-xl bg-muted p-4 space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t("amountLabel")}</span>
                <span className="text-lg font-bold font-tabular text-primary">
                  {formatKRW(paymentResult.amount)}
                  <span className="text-2xs text-muted-foreground ml-1">
                    {t("vatIncluded")}
                  </span>
                </span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">{t("txIdLabel")}</span>
                <button
                  onClick={copyTxId}
                  aria-label={t("copyAriaLabel")}
                  className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {paymentResult.paymentId}
                  <Copy className="h-3 w-3" />
                </button>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t("payMethodLabel")}</span>
                <span className="text-foreground">
                  {PAY_METHOD_LABELS[paymentResult.payMethod]}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t("paidAtLabel")}</span>
                <span className="text-muted-foreground text-xs">
                  {formatDate(paymentResult.paidAt)}
                </span>
              </div>
            </div>

            {/* 이메일 영수증 안내 */}
            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              <span>{t("receiptSent")}</span>
            </div>

            {/* 환불/취소 안내 */}
            <div className="rounded-xl border border-border p-4 space-y-2">
              <p className="text-xs font-semibold text-foreground">
                {t("refundTitle")}
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t("refundPolicy")}
              </p>
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Mail className="h-3 w-3" /> support@pickket.kr
                </span>
                <span className="flex items-center gap-1">
                  <Phone className="h-3 w-3" /> 1588-0000
                </span>
              </div>
            </div>

            {/* CTA 버튼 */}
            <div className="flex flex-col gap-3">
              <div className="flex gap-3">
                <Button
                  onClick={onViewTickets}
                  className="flex-1 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {t("viewTickets", { ticketNoun })}
                </Button>
                <Button
                  onClick={onBrowseEvents}
                  variant="outline"
                  className="flex-1 rounded-full"
                >
                  {t("browseEvents")}
                </Button>
              </div>
              {onGoToCommunity && (
                <Button
                  onClick={onGoToCommunity}
                  variant="ghost"
                  className="w-full rounded-full text-primary/70 hover:bg-primary/10"
                >
                  {t("goToCommunity")}
                </Button>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

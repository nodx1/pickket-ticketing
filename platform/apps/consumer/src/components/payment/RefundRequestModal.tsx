"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Loader2,
  AlertTriangle,
  X,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";
import { refundOrder, type OrderDetail } from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";
import { toast } from "sonner";

const MIN_REASON = 10;
const MAX_REASON = 500;

interface RefundRequestModalProps {
  open: boolean;
  order: OrderDetail;
  onClose: () => void;
  onSuccess: () => void;
}

export default function RefundRequestModal({
  open,
  order,
  onClose,
  onSuccess,
}: RefundRequestModalProps) {
  const t = useTranslations("payment.refundModal");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open || typeof window === "undefined") return null;

  const trimmed = reason.trim();
  const valid = trimmed.length >= MIN_REASON && trimmed.length <= MAX_REASON;

  const handleSubmit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await refundOrder(order.id, { reason: trimmed });
      toast.success(t("successToast"));
      onSuccess();
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? t("errorFallback");
      setError(detail);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="refund-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-background border border-border shadow-xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2
            id="refund-modal-title"
            className="text-lg font-bold text-foreground flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4 text-orange-500" />
            {t("title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label={t("closeLabel")}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* 환불 정책 안내 */}
          <div className="rounded-xl bg-muted/50 border border-border/50 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground">{t("policyHeading")}</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>{t("policyItem1")}</li>
              <li>{t("policyItem2")}</li>
              <li>{t("policyItem3")}</li>
            </ul>
            <Link
              href="/refund-policy"
              target="_blank"
              className="inline-flex items-center gap-1 text-primary hover:underline mt-1"
            >
              {t("policyLink")} <ExternalLink className="h-3 w-3" />
            </Link>
          </div>

          {/* 결제 금액 — total_amount 는 '결제한 금액'이지 확정 환불액이 아니다.
              취소 수수료가 차감될 수 있어 '환불 예정 금액'으로 표시하면 오인을 부른다(P2-C2). */}
          <div className="rounded-xl border border-border p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t("paymentAmountLabel")}</span>
              <span className="text-lg font-bold text-foreground font-tabular">
                {formatKRW(order.total_amount)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("refundAmountDisclaimer")}
            </p>
          </div>

          {/* 사유 입력 */}
          <div className="space-y-1.5">
            <label
              htmlFor="refund-reason"
              className="text-sm font-medium text-foreground"
            >
              {t("reasonLabel")} <span className="text-red-600 dark:text-red-400">*</span>
            </label>
            <textarea
              id="refund-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON))}
              disabled={submitting}
              rows={4}
              placeholder={t("reasonPlaceholder")}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50 resize-none"
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {trimmed.length < MIN_REASON
                  ? t("reasonMinHint", { n: MIN_REASON - trimmed.length })
                  : ""}
              </span>
              <span className="font-tabular">
                {trimmed.length} / {MAX_REASON}
              </span>
            </div>
          </div>

          {/* 에러 표시 */}
          {error && (
            <div className="flex items-start gap-2 rounded-xl bg-red-600/10 border border-red-600/20 p-3 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="flex-1">{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-5 border-t border-border">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={submitting}
            className="rounded-full"
          >
            {t("cancelButton")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!valid || submitting}
            className="rounded-full bg-orange-500 hover:bg-orange-600 text-white"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t("submittingLabel")}
              </>
            ) : (
              t("title")
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

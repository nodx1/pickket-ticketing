"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { issueGuestRefundToken, guestRefund } from "@pickket/lib/api";

interface GuestRefundPanelProps {
  orderId: string;
  viewToken: string;
  checkedIn: boolean;
  onRefunded: () => void;
}

/**
 * 게스트 환불 UI — 2단계:
 *   1) issueGuestRefundToken(view 토큰) → single-use refund 토큰 발급
 *   2) guestRefund(refund 토큰) → PG 환불 실행
 * 체크인된 티켓이 있으면 환불 불가 안내(서버도 거부).
 */
export function GuestRefundPanel({
  orderId,
  viewToken,
  checkedIn,
  onRefunded,
}: GuestRefundPanelProps) {
  const t = useTranslations("guest.refund");
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleRefund = useCallback(async () => {
    setSubmitting(true);
    try {
      // 1) refund 매직링크 토큰 발급(view 소유증명).
      const tokenRes = await issueGuestRefundToken(orderId, viewToken);
      const refundToken = tokenRes.data.raw_token;
      // 2) 환불 실행(single-use refund 토큰).
      const res = await guestRefund(orderId, {
        refund_token: refundToken,
        reason: t("defaultReason"),
      });
      toast.success(
        t("success", { amount: res.data.refund_amount.toLocaleString() }),
      );
      setOpen(false);
      onRefunded();
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("error");
      toast.error(detail);
    } finally {
      setSubmitting(false);
    }
  }, [orderId, viewToken, onRefunded, t]);

  return (
    <div className="rounded-2xl bg-card border border-border p-5 shadow-sm space-y-3">
      <p className="text-sm font-semibold text-content-default">{t("title")}</p>
      <p className="text-xs text-content-muted">{t("description")}</p>

      {checkedIn ? (
        <div className="rounded-xl bg-amber-600/10 border border-amber-600/20 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("checkedInBlocked")}</p>
        </div>
      ) : (
        <Button
          variant="outline"
          onClick={() => setOpen(true)}
          className="rounded-full text-orange-500 border-orange-500/30 hover:bg-orange-500/10"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          {t("cta")}
        </Button>
      )}

      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!submitting) setOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-content-default">
              {t("confirmTitle")}
            </DialogTitle>
            <DialogDescription className="text-content-muted">
              {t("confirmBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
              className="rounded-full"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => void handleRefund()}
              disabled={submitting}
              className="rounded-full bg-orange-500 hover:bg-orange-600 text-white"
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("processing")}
                </span>
              ) : (
                t("confirmCta")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

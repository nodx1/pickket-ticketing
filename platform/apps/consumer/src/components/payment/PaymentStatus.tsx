"use client";

import { motion } from "motion/react";
import { CheckCircle, Shield } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@pickket/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { formatKRW } from "@pickket/lib";

interface PaymentStatusProps {
  open: boolean;
  status: "authorized" | "captured";
  amount: number;
  eventTitle: string;
  onClose: () => void;
}

export default function PaymentStatus({
  open,
  status,
  amount,
  eventTitle,
  onClose,
}: PaymentStatusProps) {
  const t = useTranslations("payment.paymentStatus");
  const isAuthorized = status === "authorized";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isAuthorized ? t("authorizedTitle") : t("capturedTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isAuthorized
              ? t("authorizedDescription")
              : t("capturedDescription")}
          </DialogDescription>
        </DialogHeader>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <div className="flex items-center gap-3 rounded-xl border border-border p-4">
            <div
              className={
                isAuthorized
                  ? "inline-flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700"
                  : "inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
              }
            >
              {isAuthorized ? (
                <Shield className="h-5 w-5" />
              ) : (
                <CheckCircle className="h-5 w-5" />
              )}
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">
                {eventTitle}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("paymentAmount")}{" "}
                <span className="font-tabular">{formatKRW(amount)}</span>
              </p>
            </div>
          </div>

          {isAuthorized ? (
            <p className="rounded-xl bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
              {t("authorizedNotice")}
            </p>
          ) : (
            <p className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-200">
              {t("capturedNotice")}
            </p>
          )}

          <Button onClick={onClose} className="w-full rounded-full">
            {t("confirmButton")}
          </Button>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}

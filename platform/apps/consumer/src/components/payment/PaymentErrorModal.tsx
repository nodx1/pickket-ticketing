"use client";

import { motion } from "motion/react";
import { XCircle, RefreshCw, CreditCard, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { Button } from "@pickket/ui";
import { useTranslations } from "next-intl";

interface Props {
  open: boolean;
  errorMessage: string;
  onRetry: () => void;
  onChangeMethod: () => void;
  onClose: () => void;
}

export default function PaymentErrorModal({
  open,
  errorMessage,
  onRetry,
  onChangeMethod,
  onClose,
}: Props) {
  const t = useTranslations("payment.errorModal");
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
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="space-y-5 pt-4"
        >
          {/* Error icon */}
          <div className="text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 200, delay: 0.1 }}
              className="inline-flex h-16 w-16 rounded-full bg-red-100 dark:bg-red-950/30 items-center justify-center mb-3"
            >
              <XCircle className="h-8 w-8 text-red-500 dark:text-red-400" />
            </motion.div>
            <h2 className="text-xl font-bold text-foreground">
              {t("heading")}
            </h2>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              {errorMessage}
            </p>
          </div>

          {/* 액션 버튼 */}
          <div className="space-y-2.5">
            <Button
              onClick={onRetry}
              className="w-full h-12 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground text-base font-semibold"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {t("retryButton")}
            </Button>
            <Button
              onClick={onChangeMethod}
              variant="outline"
              className="w-full h-10 rounded-full text-sm"
            >
              <CreditCard className="h-4 w-4 mr-2" />
              {t("changeMethodButton")}
            </Button>
            <Button
              onClick={onClose}
              variant="ghost"
              className="w-full h-10 rounded-full text-sm text-muted-foreground"
            >
              <X className="h-4 w-4 mr-2" />
              {t("cancelButton")}
            </Button>
          </div>

          {/* 고객센터 안내 */}
          <p className="text-xs text-center text-muted-foreground">
            {t("supportHint")}
          </p>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@pickket/ui";
import { Button } from "@pickket/ui";
import { Shield, Loader2 } from "lucide-react";
import { formatKRW } from "@pickket/lib";

interface OrderConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  type: "buy" | "sell";
  price: number;
  eventTitle: string;
  tierName?: string;
  facePrice?: number;
  submitting?: boolean;
}

export default function OrderConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  type,
  price,
  eventTitle,
  tierName,
  facePrice,
  submitting = false,
}: OrderConfirmDialogProps) {
  const t = useTranslations("resale");
  const isBuy = type === "buy";
  const premium = facePrice != null ? price - facePrice : 0;
  const hasPremium = facePrice != null && premium > 0;
  const belowFace = facePrice != null && premium <= 0;

  const organizerShare = hasPremium ? Math.round(premium * 0.5) : 0;
  const platformFee = hasPremium ? Math.round(premium * 0.1) : 0;
  const sellerReceives = hasPremium
    ? price - organizerShare - platformFee
    : price;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className={isBuy ? "text-blue-600 dark:text-blue-400" : "text-red-500"}>
            {isBuy ? t("buyConfirmTitle") : t("sellConfirmTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {eventTitle} {tierName ? `· ${tierName}` : ""}
          </DialogDescription>
        </DialogHeader>

        {/* Order details */}
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("event")}</span>
            <span className="font-medium text-foreground text-right max-w-[60%] truncate">
              {eventTitle}
            </span>
          </div>
          {tierName && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("tier")}</span>
              <span className="font-medium text-foreground">{tierName}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("orderPrice")}</span>
            <span className="font-semibold text-foreground font-tabular">
              {formatKRW(price)}
            </span>
          </div>
        </div>

        {/* Fee breakdown */}
        {facePrice != null && (
          <div className="rounded-lg border border-border bg-muted p-3 space-y-2 text-sm">
            <p className="text-xs font-semibold text-muted-foreground mb-1">
              {t("feeInfo")}
            </p>

            {hasPremium ? (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("facePriceLabel")}
                  </span>
                  <span className="text-foreground font-tabular">
                    {formatKRW(facePrice)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("premium")}</span>
                  <span className="text-foreground font-tabular">
                    {formatKRW(premium)}
                  </span>
                </div>

                <hr className="border-border" />

                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("organizerPortion", { pct: 50 })}
                  </span>
                  <span className="text-foreground font-tabular">
                    {formatKRW(organizerShare)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("platformPortion", { pct: 10 })}
                  </span>
                  <span className="text-foreground font-tabular">
                    {formatKRW(platformFee)}
                  </span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span className="text-foreground">{t("sellerPayout")}</span>
                  <span className="text-foreground font-tabular">
                    {formatKRW(sellerReceives)}
                  </span>
                </div>
              </>
            ) : belowFace ? (
              <p className="text-green-600 dark:text-green-400 font-medium text-center py-1">
                {t("belowFaceNoFee")}
              </p>
            ) : null}
          </div>
        )}

        {/* Legal compliance note */}
        <div className="flex items-start gap-2 rounded-lg bg-muted border border-border p-3">
          <Shield className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground leading-relaxed">
            <span className="font-semibold text-primary">
              {t("fairTradeAuth")}
            </span>
            <br />
            {t("priceCap")}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={submitting}
            className={
              isBuy
                ? "bg-blue-600 hover:bg-blue-700 text-white"
                : "bg-red-500 hover:bg-red-600 text-white"
            }
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("processing")}
              </>
            ) : isBuy ? (
              t("buyConfirm")
            ) : (
              t("sellConfirm")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

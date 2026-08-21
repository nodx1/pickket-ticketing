"use client";

import { useTranslations } from "next-intl";
import { formatKRW } from "@pickket/lib";

interface FeeBreakdownProps {
  price: number;
  originalPrice: number;
  side: "buy" | "sell";
  platformFeeRate?: number;
  artistRoyaltyRate?: number;
}

export default function FeeBreakdown({
  price,
  originalPrice,
  side,
  platformFeeRate = 0.1,
  artistRoyaltyRate = 0.5,
}: FeeBreakdownProps) {
  const t = useTranslations("resale");
  const premium = Math.max(0, price - originalPrice);
  const platformFee = Math.round(premium * platformFeeRate);
  const organizerShare = Math.round(premium * artistRoyaltyRate);
  const sellerReceives = price - platformFee - organizerShare;
  const isParValue = premium === 0;

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex justify-between text-muted-foreground">
        <span>{t("orderAmount")}</span>
        <span className="font-mono font-medium font-tabular text-foreground">
          {formatKRW(price)}
        </span>
      </div>
      {originalPrice > 0 && (
        <div className="flex justify-between text-muted-foreground">
          <span>{t("facePrice")}</span>
          <span className="font-mono font-tabular">
            {formatKRW(originalPrice)}
          </span>
        </div>
      )}
      {isParValue ? (
        <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
          <span>{t("fee")}</span>
          <span className="font-mono font-semibold">
            {t("zeroFeeTransfer")}
          </span>
        </div>
      ) : (
        <>
          <div className="flex justify-between text-muted-foreground">
            <span>{t("premium")}</span>
            <span className="font-mono font-tabular">{formatKRW(premium)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>
              {t("organizerShare", {
                pct: Math.round(artistRoyaltyRate * 100),
              })}
            </span>
            <span className="font-mono font-tabular">
              -{formatKRW(organizerShare)}
            </span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>
              {t("platformFee", { pct: Math.round(platformFeeRate * 100) })}
            </span>
            <span className="font-mono font-tabular">
              -{formatKRW(platformFee)}
            </span>
          </div>
        </>
      )}
      <div className="border-t border-border pt-1.5 mt-1.5">
        {side === "sell" ? (
          <div className="flex justify-between font-semibold text-foreground">
            <span>{t("sellerReceives")}</span>
            <span className="font-mono font-tabular text-emerald-600 dark:text-emerald-400">
              {formatKRW(sellerReceives)}
            </span>
          </div>
        ) : (
          <div className="flex justify-between font-semibold text-foreground">
            <span>{t("totalPayment")}</span>
            <span className="font-mono font-tabular text-blue-600 dark:text-blue-400">
              {formatKRW(price)}
            </span>
          </div>
        )}
      </div>
      <p className="text-2xs text-muted-foreground text-right">
        {t("taxIncluded")}
      </p>
    </div>
  );
}

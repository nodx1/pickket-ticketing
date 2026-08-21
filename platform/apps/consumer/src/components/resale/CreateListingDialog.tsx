"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertCircle, AlertTriangle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@pickket/ui";
import { Button } from "@pickket/ui";
import { Input } from "@pickket/ui";
import { createResaleListing } from "@pickket/lib/api";
import { formatKRW } from "@pickket/lib";
import FeeBreakdown from "@/components/resale/FeeBreakdown";

interface CreateListingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: {
    id: string;
    event_id: string;
    event_title: string;
    tier_name: string;
    original_price?: number;
  };
  onSuccess?: () => void;
}

const PRICE_CEILING = 1_000_000;

export default function CreateListingDialog({
  open,
  onOpenChange,
  ticket,
  onSuccess,
}: CreateListingDialogProps) {
  const t = useTranslations("resale");
  const [askingPrice, setAskingPrice] = useState<number>(
    ticket.original_price ?? 0,
  );
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAskingPrice(ticket.original_price ?? 0);
    setInlineError(null);
  }, [open, ticket.id, ticket.original_price]);

  const originalPrice = ticket.original_price ?? 0;
  const isZeroFeeCandidate =
    originalPrice > 0 && askingPrice > 0 && askingPrice <= originalPrice;

  // B2: 실시간 가격 유효성 검사
  const priceValidation = (() => {
    if (askingPrice < 0) {
      return { type: "error" as const, message: t("priceRequired") };
    }
    if (askingPrice > 0 && askingPrice < 1000) {
      return { type: "warning" as const, message: t("priceTooLow") };
    }
    if (originalPrice > 0 && askingPrice > 0 && askingPrice < originalPrice) {
      const pct = Math.round((askingPrice / originalPrice) * 100);
      return { type: "info" as const, message: t("belowFacePrice", { pct }) };
    }
    if (askingPrice > PRICE_CEILING) {
      return {
        type: "error" as const,
        message: t("priceExceeded", { amount: "1,000,000" }),
      };
    }
    if (originalPrice > 0 && askingPrice > originalPrice * 3) {
      return { type: "warning" as const, message: t("priceHighWarning") };
    }
    return null;
  })();

  const handlePriceChange = (value: number) => {
    setAskingPrice(value);
    setInlineError(null);
  };

  const handleSubmit = async () => {
    if (!askingPrice || askingPrice <= 0) {
      setInlineError(t("priceRequired"));
      return;
    }
    if (askingPrice > PRICE_CEILING) {
      setInlineError(t("priceExceeded", { amount: "1,000,000" }));
      return;
    }

    setSubmitting(true);
    setInlineError(null);
    try {
      await createResaleListing({
        ticket_id: ticket.id,
        asking_price: askingPrice,
      });
      toast.success(t("listingSuccess"));
      onSuccess?.();
      onOpenChange(false);
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("listingFailed");
      setInlineError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("createListing")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("createListing")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl bg-surface-dim p-4">
            <p className="text-sm font-semibold text-foreground">
              {ticket.event_title}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {ticket.tier_name}
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              {t("facePriceLabel")}
            </p>
            <p className="text-sm font-semibold text-foreground font-tabular">
              {formatKRW(originalPrice)}
            </p>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="askingPrice"
              className="text-sm font-medium text-foreground"
            >
              {t("askingPriceLabel")}
            </label>
            <Input
              id="askingPrice"
              type="number"
              min={1}
              max={PRICE_CEILING}
              step={1000}
              value={askingPrice || ""}
              onChange={(e) => handlePriceChange(Number(e.target.value || 0))}
              placeholder={t("askingPricePlaceholder")}
            />
            {/* B2: 실시간 인라인 유효성 피드백 */}
            {priceValidation?.type === "error" && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3 flex-shrink-0" />
                {priceValidation.message}
              </p>
            )}
            {priceValidation?.type === "warning" && (
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                {priceValidation.message}
              </p>
            )}
            {priceValidation?.type === "info" && (
              <p className="text-xs text-blue-500 flex items-center gap-1">
                <AlertCircle className="h-3 w-3 flex-shrink-0" />
                {priceValidation.message}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-border p-3">
            <FeeBreakdown
              price={askingPrice || 0}
              originalPrice={originalPrice}
              side="sell"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {t("maxPriceInfo", { amount: "1,000,000" })}
          </p>
          {isZeroFeeCandidate && (
            <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {t("zeroFeePromo")}
            </p>
          )}

          {/* B2: 인라인 에러 배너 */}
          {inlineError && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{inlineError}</span>
            </div>
          )}

          <Button
            onClick={handleSubmit}
            disabled={submitting || !askingPrice}
            className="w-full rounded-full bg-red-600 text-white hover:bg-red-700"
          >
            {submitting ? t("registering") : t("register")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

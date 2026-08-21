"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Button } from "@pickket/ui";
import { useResaleStore } from "@/store/resale";
import FeeBreakdown from "./FeeBreakdown";
import OrderConfirmDialog from "./OrderConfirmDialog";
import type { MarketSummary } from "@/hooks/useMarketStream";

interface OrderPanelProps {
  summary: MarketSummary;
  eventTitle?: string;
  tierName?: string;
  originalPrice?: number;
  onSubmitBuy?: (price: number) => Promise<void> | void;
  onSubmitSell?: (price: number) => Promise<void> | void;
  /** 낙관적 주문 콜백 */
  onOptimisticAdd?: (entry: {
    price: number;
    quantity: number;
    side: "bid" | "ask";
  }) => string;
  onOptimisticConfirm?: (id: string) => void;
  onOptimisticFail?: (id: string) => void;
}

export default function OrderPanel({
  summary,
  eventTitle,
  tierName,
  originalPrice = 0,
  onSubmitBuy,
  onSubmitSell,
  onOptimisticAdd,
  onOptimisticConfirm,
  onOptimisticFail,
}: OrderPanelProps) {
  const t = useTranslations("resale");
  const {
    orderSide,
    orderPrice,
    orderQuantity,
    setOrderSide,
    setOrderPrice,
    setOrderQuantity,
  } = useResaleStore();
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmType, setConfirmType] = useState<"buy" | "sell">("buy");
  const [confirmPrice, setConfirmPrice] = useState(0);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const resolvedEventTitle = eventTitle ?? t("market");

  // 가격 유효성 검사 메시지
  const priceValidation = (() => {
    if (orderPrice < 0)
      return { type: "error" as const, message: t("priceRequired") };
    if (originalPrice > 0 && orderPrice > originalPrice * 3) {
      return { type: "warning" as const, message: t("priceHighWarning") };
    }
    return null;
  })();

  // 인라인 에러 초기화: 유저가 입력 변경 시
  const handlePriceChange = useCallback(
    (value: number) => {
      setOrderPrice(value);
      setInlineError(null);
    },
    [setOrderPrice],
  );

  const handleQuantityChange = useCallback(
    (value: number) => {
      setOrderQuantity(value);
      setInlineError(null);
    },
    [setOrderQuantity],
  );

  const handleSubmit = () => {
    if (orderPrice <= 0) {
      setInlineError(t("priceRequired"));
      return;
    }
    setInlineError(null);
    setConfirmType(orderSide);
    setConfirmPrice(orderPrice);
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    if (confirmType === "buy") {
      setSubmitting(true);
      setConfirmOpen(false);
      const optId = onOptimisticAdd?.({
        price: confirmPrice,
        quantity: orderQuantity,
        side: "bid",
      });

      try {
        await onSubmitBuy?.(confirmPrice);
        if (optId) onOptimisticConfirm?.(optId);
      } catch (err: unknown) {
        if (optId) onOptimisticFail?.(optId);
        const message =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail || t("orderFailed");
        setInlineError(message);
      } finally {
        setSubmitting(false);
      }
    } else {
      // 매도 주문: 낙관적 업데이트 + API 호출
      const optId = onOptimisticAdd?.({
        price: confirmPrice,
        quantity: orderQuantity,
        side: "ask",
      });

      setSubmitting(true);
      try {
        await onSubmitSell?.(confirmPrice);
        if (optId) onOptimisticConfirm?.(optId);
      } catch (err: unknown) {
        if (optId) onOptimisticFail?.(optId);
        const message =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail || t("orderFailed");
        setInlineError(message);
      } finally {
        setSubmitting(false);
        setConfirmOpen(false);
      }
    }
  };

  const isBuy = orderSide === "buy";

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden h-full flex flex-col">
      {/* Tab Header */}
      <div className="flex border-b border-border">
        <button
          onClick={() => {
            setOrderSide("buy");
            setInlineError(null);
          }}
          className={`flex-1 py-3 text-sm font-semibold text-center transition-colors ${
            isBuy
              ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 bg-blue-50/30"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("buy")}
        </button>
        <button
          onClick={() => {
            setOrderSide("sell");
            setInlineError(null);
          }}
          className={`flex-1 py-3 text-sm font-semibold text-center transition-colors ${
            !isBuy
              ? "text-red-500 border-b-2 border-red-500 bg-red-50/30"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("sell")}
        </button>
      </div>

      {/* Form */}
      <div className="p-4 flex-1 flex flex-col gap-4">
        {/* Price input — D2: 오더북 클릭 시 scale bounce */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            {isBuy ? t("maxBuyPrice") : t("askingPrice")}
          </label>
          <motion.div
            key={orderPrice}
            initial={{ scale: 1.03 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.15, type: "spring", stiffness: 400 }}
          >
            <div className="relative">
              <input
                type="number"
                value={orderPrice || ""}
                onChange={(e) => handlePriceChange(Number(e.target.value))}
                placeholder="0"
                className="w-full h-10 px-3 pr-8 rounded-lg border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {t("won")}
              </span>
            </div>
          </motion.div>

          {/* 가격 유효성 인라인 피드백 */}
          {priceValidation?.type === "error" && (
            <p className="mt-1 text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {priceValidation.message}
            </p>
          )}
          {priceValidation?.type === "warning" && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {priceValidation.message}
            </p>
          )}

          {summary.current_price && (
            <button
              onClick={() => handlePriceChange(summary.current_price!)}
              className="text-2xs text-blue-500 hover:text-blue-700 mt-1"
            >
              {t("currentPriceApply", {
                price: summary.current_price.toLocaleString("ko-KR"),
              })}
            </button>
          )}
        </div>

        {/* Quantity input */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            {t("quantity")}
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleQuantityChange(orderQuantity - 1)}
              aria-label={t("decreaseQuantity")}
              className="w-8 h-8 rounded-lg border border-border text-muted-foreground hover:bg-muted flex items-center justify-center text-sm"
            >
              −
            </button>
            <input
              type="number"
              value={orderQuantity}
              onChange={(e) => handleQuantityChange(Number(e.target.value))}
              min={1}
              className="flex-1 h-8 px-3 rounded-lg border border-border text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <button
              onClick={() => handleQuantityChange(orderQuantity + 1)}
              aria-label={t("increaseQuantity")}
              className="w-8 h-8 rounded-lg border border-border text-muted-foreground hover:bg-muted flex items-center justify-center text-sm"
            >
              +
            </button>
          </div>
        </div>

        {/* Fee breakdown */}
        {orderPrice > 0 && (
          <div className="rounded-lg bg-muted p-3">
            <FeeBreakdown
              price={orderPrice * orderQuantity}
              originalPrice={originalPrice * orderQuantity}
              side={orderSide}
            />
          </div>
        )}

        {/* Submit button */}
        <div className="mt-auto pt-2">
          <Button
            onClick={handleSubmit}
            disabled={orderPrice <= 0 || submitting}
            className={`w-full h-11 rounded-lg font-semibold text-sm ${
              isBuy
                ? "bg-blue-600 hover:bg-blue-700 text-white"
                : "bg-red-500 hover:bg-red-600 text-white"
            }`}
          >
            {submitting
              ? t("processing")
              : isBuy
                ? t("buyOrder")
                : t("sellOrder")}
          </Button>
        </div>

        {/* 인라인 에러 배너 — 토스트 대신 폼 하단에 표시 */}
        {inlineError && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="mt-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive flex items-center gap-2"
          >
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{inlineError}</span>
          </motion.div>
        )}

        {/* Info text */}
        <p className="text-2xs text-muted-foreground text-center leading-relaxed">
          {isBuy
            ? t("buyMatchInfo")
            : t("sellFeeInfo", { artistPct: 50, platformPct: 10 })}
        </p>
      </div>

      {/* Order confirm dialog */}
      <OrderConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handleConfirm}
        type={confirmType}
        price={confirmPrice}
        eventTitle={resolvedEventTitle}
        tierName={tierName}
        facePrice={originalPrice > 0 ? originalPrice : undefined}
        submitting={submitting}
      />
    </div>
  );
}

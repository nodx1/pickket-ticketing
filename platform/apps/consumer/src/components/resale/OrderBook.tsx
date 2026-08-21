"use client";

import { useMemo, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "motion/react";
import { formatKRW } from "@pickket/lib";
import type { OrderBookLevel } from "@/hooks/useMarketStream";
import type { OptimisticEntry } from "@/hooks/useOptimisticOrder";
import { useResaleStore } from "@/store/resale";

interface OrderBookProps {
  askLevels: OrderBookLevel[];
  bidLevels: OrderBookLevel[];
  /** 낙관적 주문 항목 (오더북에 머지 표시) */
  optimisticEntries?: OptimisticEntry[];
}

export default function OrderBook({
  askLevels,
  bidLevels,
  optimisticEntries = [],
}: OrderBookProps) {
  const t = useTranslations("resale");
  const setOrderPrice = useResaleStore((s) => s.setOrderPrice);

  // D2: 클릭 시 행 플래시 효과
  const [flashPrice, setFlashPrice] = useState<number | null>(null);

  const handlePriceClick = useCallback(
    (price: number) => {
      setOrderPrice(price);
      setFlashPrice(price);
      setTimeout(() => setFlashPrice(null), 150);
    },
    [setOrderPrice],
  );

  // 낙관적 항목을 실제 레벨에 머지
  const mergedAskLevels = useMemo(() => {
    const optAsks = optimisticEntries.filter(
      (e) => e.side === "ask" && e.status !== "failed",
    );
    if (optAsks.length === 0)
      return askLevels.map((l) => ({ ...l, isOptimistic: false }));

    const merged = askLevels.map((l) => ({ ...l, isOptimistic: false }));
    for (const opt of optAsks) {
      const existing = merged.find((l) => l.price === opt.price);
      if (existing) {
        existing.quantity += opt.quantity;
        existing.total_volume += opt.price * opt.quantity;
        existing.isOptimistic = true;
      } else {
        merged.push({
          price: opt.price,
          quantity: opt.quantity,
          total_volume: opt.price * opt.quantity,
          isOptimistic: true,
        });
      }
    }
    // ask: 가격 오름차순
    return merged.sort((a, b) => a.price - b.price);
  }, [askLevels, optimisticEntries]);

  const mergedBidLevels = useMemo(() => {
    const optBids = optimisticEntries.filter(
      (e) => e.side === "bid" && e.status !== "failed",
    );
    if (optBids.length === 0)
      return bidLevels.map((l) => ({ ...l, isOptimistic: false }));

    const merged = bidLevels.map((l) => ({ ...l, isOptimistic: false }));
    for (const opt of optBids) {
      const existing = merged.find((l) => l.price === opt.price);
      if (existing) {
        existing.quantity += opt.quantity;
        existing.total_volume += opt.price * opt.quantity;
        existing.isOptimistic = true;
      } else {
        merged.push({
          price: opt.price,
          quantity: opt.quantity,
          total_volume: opt.price * opt.quantity,
          isOptimistic: true,
        });
      }
    }
    // bid: 가격 내림차순
    return merged.sort((a, b) => b.price - a.price);
  }, [bidLevels, optimisticEntries]);

  const maxQuantity = useMemo(() => {
    const allQty = [...mergedAskLevels, ...mergedBidLevels].map(
      (l) => l.quantity,
    );
    return Math.max(...allQty, 1);
  }, [mergedAskLevels, mergedBidLevels]);

  const spread = useMemo(() => {
    if (mergedAskLevels.length === 0 || mergedBidLevels.length === 0)
      return null;
    const lowestAsk = mergedAskLevels[0].price;
    const highestBid = mergedBidLevels[0].price;
    const diff = lowestAsk - highestBid;
    const pct = highestBid > 0 ? (diff / highestBid) * 100 : 0;
    return { diff, pct };
  }, [mergedAskLevels, mergedBidLevels]);

  // Reverse asks so highest price is at top
  const displayAsks = [...mergedAskLevels].reverse();

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border bg-muted/50">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {t("orderBook")}
        </h3>
      </div>

      {/* Column labels */}
      <div className="grid grid-cols-2 sm:grid-cols-3 px-4 py-1.5 text-2xs text-muted-foreground uppercase tracking-wider border-b border-border">
        <span>{t("price")}</span>
        <span className="text-right">{t("quantity")}</span>
        <span className="text-right hidden sm:block">{t("total")}</span>
      </div>

      {/* Ask levels (sell orders) -- red */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="flex flex-col justify-end min-h-[180px]">
          {displayAsks.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-8">
              {t("noAsk")}
            </div>
          )}
          <AnimatePresence mode="popLayout">
            {displayAsks.map((level) => {
              const barWidth = (level.quantity / maxQuantity) * 100;
              const isFlash = flashPrice === level.price;
              return (
                <motion.button
                  key={`ask-${level.price}`}
                  layout
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  onClick={() => handlePriceClick(level.price)}
                  aria-label={t("askLevel", {
                    price: level.price.toLocaleString("ko-KR"),
                    quantity: level.quantity,
                  })}
                  className={`grid grid-cols-2 sm:grid-cols-3 px-4 py-1 text-xs relative hover:bg-red-50/50 transition-colors cursor-pointer ${
                    isFlash ? "bg-primary/10" : ""
                  } ${level.isOptimistic ? "opacity-60 animate-pulse" : ""}`}
                >
                  <div
                    className="absolute inset-y-0 right-0 bg-red-500/[0.06]"
                    style={{ width: `${barWidth}%` }}
                  />
                  <span className="font-mono font-medium font-tabular text-red-500 relative z-10">
                    {formatKRW(level.price)}
                  </span>
                  <span className="font-mono text-muted-foreground text-right relative z-10">
                    {level.quantity}
                  </span>
                  <span className="font-mono font-tabular text-muted-foreground text-right relative z-10 hidden sm:block">
                    {formatKRW(level.total_volume)}
                  </span>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>

        {/* Spread */}
        <div className="px-4 py-2 bg-muted border-y border-border flex items-center justify-between">
          <span className="text-2xs text-muted-foreground uppercase">
            {t("spread")}
          </span>
          {spread ? (
            <span className="text-xs font-mono font-semibold font-tabular text-muted-foreground">
              {formatKRW(spread.diff)} ({spread.pct.toFixed(1)}%)
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>

        {/* Bid levels (buy orders) -- blue */}
        <div className="min-h-[180px]">
          {mergedBidLevels.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-8">
              {t("noBid")}
            </div>
          )}
          <AnimatePresence mode="popLayout">
            {mergedBidLevels.map((level) => {
              const barWidth = (level.quantity / maxQuantity) * 100;
              const isFlash = flashPrice === level.price;
              return (
                <motion.button
                  key={`bid-${level.price}`}
                  layout
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  onClick={() => handlePriceClick(level.price)}
                  aria-label={t("bidLevel", {
                    price: level.price.toLocaleString("ko-KR"),
                    quantity: level.quantity,
                  })}
                  className={`grid grid-cols-2 sm:grid-cols-3 px-4 py-1 text-xs relative hover:bg-blue-50/50 transition-colors cursor-pointer w-full text-left ${
                    isFlash ? "bg-primary/10" : ""
                  } ${level.isOptimistic ? "opacity-60 animate-pulse" : ""}`}
                >
                  <div
                    className="absolute inset-y-0 right-0 bg-blue-500/[0.06]"
                    style={{ width: `${barWidth}%` }}
                  />
                  <span className="font-mono font-medium font-tabular text-blue-600 dark:text-blue-400 relative z-10">
                    {formatKRW(level.price)}
                  </span>
                  <span className="font-mono text-muted-foreground text-right relative z-10">
                    {level.quantity}
                  </span>
                  <span className="font-mono font-tabular text-muted-foreground text-right relative z-10 hidden sm:block">
                    {formatKRW(level.total_volume)}
                  </span>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

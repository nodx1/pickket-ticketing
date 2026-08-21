"use client";

import { useTranslations } from "next-intl";
import { formatKRW } from "@pickket/lib";
import type { TradeRecord } from "@/hooks/useMarketStream";

function formatTime(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

interface TradeHistoryProps {
  trades: TradeRecord[];
}

export default function TradeHistory({ trades }: TradeHistoryProps) {
  const t = useTranslations("resale");

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border bg-muted/50">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {t("tradeHistory")}
        </h3>
      </div>

      {/* Column labels */}
      <div className="grid grid-cols-2 sm:grid-cols-3 px-4 py-1.5 text-2xs text-muted-foreground uppercase tracking-wider border-b border-border">
        <span>{t("time")}</span>
        <span className="text-right">{t("price")}</span>
        <span className="text-right hidden sm:block">{t("fee")}</span>
      </div>

      {/* Trades */}
      <div className="flex-1 overflow-y-auto min-h-0 max-h-[300px]">
        {trades.length === 0 && (
          <div className="text-center text-xs text-muted-foreground py-8">
            {t("noTrades")}
          </div>
        )}
        {trades.map((trade, i) => {
          // Determine direction by comparing with previous trade
          const prevPrice =
            i < trades.length - 1 ? trades[i + 1].price : trade.price;
          const isUp = trade.price > prevPrice;
          const isDown = trade.price < prevPrice;

          return (
            <div
              key={`${trade.ticket_id}-${i}`}
              className="grid grid-cols-2 sm:grid-cols-3 px-4 py-1.5 text-xs hover:bg-muted/50 transition-colors"
            >
              <span className="font-mono text-muted-foreground">
                {formatTime(trade.transferred_at)}
              </span>
              <span
                className={`font-mono font-medium font-tabular text-right ${
                  isUp
                    ? "text-emerald-600 dark:text-emerald-400"
                    : isDown
                      ? "text-red-500"
                      : "text-foreground"
                }`}
              >
                {formatKRW(trade.price)}
              </span>
              <span className="font-mono font-tabular text-muted-foreground text-right hidden sm:block">
                {formatKRW(trade.platform_fee)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

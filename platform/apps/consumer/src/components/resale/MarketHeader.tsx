"use client";

import { useRef, useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Activity,
  BarChart3,
  ShoppingBag,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { formatKRW } from "@pickket/lib";
import type { MarketSummary } from "@/hooks/useMarketStream";

interface MarketHeaderProps {
  summary: MarketSummary;
  eventTitle?: string;
  tierName?: string;
  connected: boolean;
  /** B3: 수동 재연결 함수 */
  onReconnect?: () => void;
}

export default function MarketHeader({
  summary,
  eventTitle,
  tierName,
  connected,
  onReconnect,
}: MarketHeaderProps) {
  const t = useTranslations("resale");
  const resolvedTitle = eventTitle ?? t("market");
  const isUp = summary.price_change > 0;
  const isDown = summary.price_change < 0;

  // D1: 가격 변동 플래시 애니메이션
  const prevPriceRef = useRef<number | null>(null);
  const [flashDirection, setFlashDirection] = useState<"up" | "down" | null>(
    null,
  );

  useEffect(() => {
    if (summary.current_price === null) return;
    const prev = prevPriceRef.current;
    if (prev !== null && prev !== summary.current_price) {
      setFlashDirection(summary.current_price > prev ? "up" : "down");
      const timer = setTimeout(() => setFlashDirection(null), 600);
      return () => clearTimeout(timer);
    }
    prevPriceRef.current = summary.current_price;
  }, [summary.current_price]);

  // 이전 가격을 항상 갱신 (effect 분리 — 클린업과 별도로 ref 갱신)
  useEffect(() => {
    if (summary.current_price !== null) {
      prevPriceRef.current = summary.current_price;
    }
  }, [summary.current_price]);

  // B3: 재연결 중 스피너 표시
  const [reconnecting, setReconnecting] = useState(false);
  const handleReconnect = () => {
    if (reconnecting) return;
    setReconnecting(true);
    onReconnect?.();
    // 2초 후 스피너 해제 (실제 연결은 connected 상태로 판단)
    setTimeout(() => setReconnecting(false), 2000);
  };

  // connected 되면 즉시 reconnecting 해제
  useEffect(() => {
    if (connected) setReconnecting(false);
  }, [connected]);

  return (
    <div className="bg-card border-b border-border px-4 py-3 md:px-6 md:py-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        {/* Left: Title + Current Price */}
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-foreground">
                {resolvedTitle}
              </h1>
              {tierName && (
                <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
                  {tierName}
                </span>
              )}
              <span
                role="status"
                aria-live="polite"
                className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                  connected
                    ? "bg-emerald-50 text-emerald-600"
                    : "bg-red-50 text-red-500"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    connected ? "bg-emerald-500 animate-pulse" : "bg-red-400"
                  }`}
                />
                {connected ? t("live") : t("disconnected")}
              </span>
              {/* B3: 연결 끊김 시 재연결 버튼 */}
              {!connected && onReconnect && (
                <button
                  onClick={handleReconnect}
                  disabled={reconnecting}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-50"
                >
                  {reconnecting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  {t("reconnect")}
                </button>
              )}
            </div>
            <div className="flex items-baseline gap-3 mt-1">
              {/* D1: 가격 플래시 — 배경색 전환 */}
              <motion.span
                className="text-2xl font-bold font-mono font-tabular text-foreground rounded px-1 -mx-1"
                animate={{
                  backgroundColor:
                    flashDirection === "up"
                      ? "rgba(16,185,129,0.2)"
                      : flashDirection === "down"
                        ? "rgba(239,68,68,0.2)"
                        : "rgba(0,0,0,0)",
                }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              >
                {summary.current_price ? formatKRW(summary.current_price) : "—"}
              </motion.span>
              {summary.current_price && (
                <span
                  className={`flex items-center gap-0.5 text-sm font-semibold font-tabular ${
                    isUp
                      ? "text-emerald-600 dark:text-emerald-400"
                      : isDown
                        ? "text-red-500"
                        : "text-muted-foreground"
                  }`}
                >
                  {isUp && <TrendingUp className="h-3.5 w-3.5" />}
                  {isDown && <TrendingDown className="h-3.5 w-3.5" />}
                  {!isUp && !isDown && <Minus className="h-3.5 w-3.5" />}
                  {isUp ? "+" : ""}
                  {formatKRW(summary.price_change)} ({isUp ? "+" : ""}
                  {summary.price_change_pct}%)
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: Stats */}
        <div className="flex items-center gap-4 md:gap-6">
          <div className="text-center">
            <p className="text-2xs text-muted-foreground uppercase tracking-wider">
              {t("dayHigh")}
            </p>
            <p className="text-sm font-semibold font-mono font-tabular text-foreground">
              {summary.day_high ? formatKRW(summary.day_high) : "—"}
            </p>
          </div>
          <div className="text-center">
            <p className="text-2xs text-muted-foreground uppercase tracking-wider">
              {t("dayLow")}
            </p>
            <p className="text-sm font-semibold font-mono font-tabular text-foreground">
              {summary.day_low ? formatKRW(summary.day_low) : "—"}
            </p>
          </div>
          <div className="text-center">
            <p className="text-2xs text-muted-foreground uppercase tracking-wider flex items-center gap-1 justify-center">
              <Activity className="h-3 w-3" /> {t("volume")}
            </p>
            <p className="text-sm font-semibold font-mono font-tabular text-foreground">
              {summary.day_volume}
              {t("unit")}
            </p>
          </div>
          <div className="text-center">
            <p className="text-2xs text-muted-foreground uppercase tracking-wider flex items-center gap-1 justify-center">
              <BarChart3 className="h-3 w-3" /> {t("listings")}
            </p>
            <p className="text-sm font-semibold font-mono font-tabular text-foreground">
              {summary.total_listings}
              {t("unit")}
            </p>
          </div>
          <div className="text-center">
            <p className="text-2xs text-muted-foreground uppercase tracking-wider flex items-center gap-1 justify-center">
              <ShoppingBag className="h-3 w-3" /> {t("buyOrders")}
            </p>
            <p className="text-sm font-semibold font-mono font-tabular text-foreground">
              {summary.total_buy_orders}
              {t("unit")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  Repeat2,
  TrendingUp,
  BarChart3,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  Button,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@pickket/ui";
import { formatKRW } from "@pickket/lib";
import {
  getResaleEvents,
  getResaleFeeInfo,
  getTradingData,
  isApiCanceled,
  type ResaleEventInfo,
  type ResaleFeeInfo,
  type TradingData,
} from "@pickket/lib/api";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import KpiCard from "../../components/KpiCard";

const CATEGORY_VALUES = [
  "all",
  "concert",
  "sports",
  "festival",
  "exhibition",
  "classical",
  "musical",
  "esports",
] as const;

const REFRESH_INTERVAL = 60_000;

export default function AdminResalePage() {
  const t = useTranslations("resale");
  const [events, setEvents] = useState<ResaleEventInfo[]>([]);
  const [feeInfo, setFeeInfo] = useState<ResaleFeeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("all");
  const [activeOnly, setActiveOnly] = useState(true);

  // Sheet detail state
  const [selectedEvent, setSelectedEvent] = useState<ResaleEventInfo | null>(
    null,
  );
  const [tradingData, setTradingData] = useState<TradingData | null>(null);
  const [tradingLoading, setTradingLoading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Sort state
  const [sortKey, setSortKey] = useState<"listing_count" | "lowest" | "volume">(
    "listing_count",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const cat = category !== "all" ? category : undefined;

      const [eventsRes, feeRes] = await Promise.allSettled([
        getResaleEvents(cat, 0, 100).then((r) => r.data),
        getResaleFeeInfo().then((r) => r.data),
      ]);

      if (eventsRes.status === "rejected" && isApiCanceled(eventsRes.reason))
        return;
      if (eventsRes.status === "fulfilled") setEvents(eventsRes.value);
      if (feeRes.status === "fulfilled") setFeeInfo(feeRes.value);
    } catch (err) {
      if (isApiCanceled(err)) return;
      toast.error(t("errorLoadResale"));
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Auto-refresh every 60s
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      load();
    }, REFRESH_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [load]);

  const openDetail = async (event: ResaleEventInfo) => {
    setSelectedEvent(event);
    setSheetOpen(true);
    setTradingData(null);

    if (event.tiers.length === 0) return;

    setTradingLoading(true);
    try {
      const { data } = await getTradingData(
        event.event_id,
        event.tiers[0].tier_id,
      );
      setTradingData(data);
    } catch {
      toast.error(t("errorLoadTrading"));
    } finally {
      setTradingLoading(false);
    }
  };

  // Computed KPIs
  const totalListings = events.reduce(
    (sum, e) => sum + e.tiers.reduce((s, tier) => s + tier.listing_count, 0),
    0,
  );

  const todayVolume = events.reduce(
    (sum, e) =>
      sum +
      e.tiers.reduce((s, tier) => s + tier.listing_count * (tier.lowest_ask ?? 0), 0),
    0,
  );

  const premiumRates = events.flatMap((e) =>
    e.tiers
      .filter(
        (tier) =>
          tier.lowest_ask !== null &&
          tier.lowest_ask !== undefined &&
          tier.base_price > 0,
      )
      .map((tier) => ((tier.lowest_ask! - tier.base_price) / tier.base_price) * 100),
  );
  const avgPremium =
    premiumRates.length > 0
      ? premiumRates.reduce((a, b) => a + b, 0) / premiumRates.length
      : 0;

  // Sorting helpers
  const getEventListingCount = (e: ResaleEventInfo) =>
    e.tiers.reduce((s, tier) => s + tier.listing_count, 0);

  const getEventLowest = (e: ResaleEventInfo) => {
    const asks = e.tiers
      .map((tier) => tier.lowest_ask)
      .filter((v): v is number => v != null);
    return asks.length > 0 ? Math.min(...asks) : 0;
  };

  const getEventVolume = (e: ResaleEventInfo) =>
    e.tiers.reduce((s, tier) => s + tier.listing_count * (tier.lowest_ask ?? 0), 0);

  const sortedEvents = [...events].sort((a, b) => {
    let aVal = 0;
    let bVal = 0;
    if (sortKey === "listing_count") {
      aVal = getEventListingCount(a);
      bVal = getEventListingCount(b);
    } else if (sortKey === "lowest") {
      aVal = getEventLowest(a);
      bVal = getEventLowest(b);
    } else {
      aVal = getEventVolume(a);
      bVal = getEventVolume(b);
    }
    return sortDir === "desc" ? bVal - aVal : aVal - bVal;
  });

  const handleSort = (key: typeof sortKey) => {
    setSortDir((prev) => (sortKey === key && prev === "desc" ? "asc" : "desc"));
    setSortKey(key);
  };

  const SortIcon = ({ col }: { col: typeof sortKey }) => {
    if (sortKey !== col) return null;
    return sortDir === "desc" ? (
      <ChevronDown className="inline h-3 w-3" />
    ) : (
      <ChevronUp className="inline h-3 w-3" />
    );
  };

  // Chart data from candles
  const chartData =
    tradingData?.candles?.map((c) => ({
      time: c.timestamp.slice(5, 10),
      price: c.close,
      volume: c.volume,
    })) ?? [];

  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <h1 className="sr-only">{t("pageTitle")}</h1>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-[160px] rounded-full">
            <SelectValue placeholder={t("categoryPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_VALUES.map((v) => (
              <SelectItem key={v} value={v}>
                {t(`category.${v}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={activeOnly ? "default" : "outline"}
          size="sm"
          className="rounded-full"
          onClick={() => setActiveOnly((v) => !v)}
        >
          {activeOnly ? t("activeOnly") : t("all")}
        </Button>

        <Button variant="ghost" size="sm" onClick={() => load()}>
          <RefreshCw className="h-4 w-4 mr-1" />
          {t("refresh")}
        </Button>
      </div>

      {/* KPI Cards */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 sm:grid-cols-3 gap-4"
      >
        <KpiCard
          label={t("kpi.activeListings")}
          value={String(totalListings)}
          icon={Repeat2}
          iconColor="text-purple-500"
        />
        <KpiCard
          label={t("kpi.todayVolume")}
          value={formatKRW(todayVolume)}
          icon={TrendingUp}
          iconColor="text-emerald-500"
        />
        <KpiCard
          label={t("kpi.avgPremium")}
          value={`${avgPremium.toFixed(1)}%`}
          icon={BarChart3}
          iconColor="text-blue-500"
        />
      </motion.div>

      {/* Resale Events Table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-lg border border-border bg-card"
      >
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">
            {t("tableTitle", { count: events.length ?? 0 })}
          </h3>
        </div>

        {sortedEvents.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted-foreground">
            {t("noData")}
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-7 gap-2 px-5 py-2.5 text-xs font-medium text-muted-foreground border-b border-border">
              <span className="col-span-2">{t("col.event")}</span>
              <span className="text-right">{t("col.tierCount")}</span>
              <button
                type="button"
                className="text-right hover:text-foreground"
                onClick={() => handleSort("listing_count")}
              >
                {t("col.listingCount")} <SortIcon col="listing_count" />
              </button>
              <button
                type="button"
                className="text-right hover:text-foreground"
                onClick={() => handleSort("lowest")}
              >
                {t("col.lowestHighest")} <SortIcon col="lowest" />
              </button>
              <button
                type="button"
                className="text-right hover:text-foreground"
                onClick={() => handleSort("volume")}
              >
                {t("col.volume")} <SortIcon col="volume" />
              </button>
              <span className="text-right">{t("col.category")}</span>
            </div>

            <div className="divide-y divide-border">
              {sortedEvents.map((e) => {
                const listingCount = getEventListingCount(e);
                const lowest = getEventLowest(e);
                const highestAsks = e.tiers
                  .map((tier) => tier.lowest_ask)
                  .filter((v): v is number => v != null);
                const highest =
                  highestAsks.length > 0 ? Math.max(...highestAsks) : 0;
                const volume = getEventVolume(e);

                return (
                  <button
                    type="button"
                    key={e.event_id}
                    className="grid grid-cols-2 md:grid-cols-7 gap-2 px-5 py-3 text-sm items-center w-full text-left hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => openDetail(e)}
                  >
                    <span className="col-span-2 font-medium truncate">
                      {e.title}
                    </span>
                    <span className="text-right hidden md:block font-tabular">
                      {e.tiers.length}
                    </span>
                    <span className="text-right hidden md:block font-tabular">
                      {listingCount.toLocaleString()}
                    </span>
                    <span className="text-right hidden md:block font-tabular text-xs">
                      {lowest > 0 ? formatKRW(lowest) : "-"} /{" "}
                      {highest > 0 ? formatKRW(highest) : "-"}
                    </span>
                    <span className="text-right hidden md:block font-tabular">
                      {formatKRW(volume)}
                    </span>
                    <span className="text-right hidden md:block">
                      <Badge variant="secondary" className="text-xs">
                        {e.category}
                      </Badge>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </motion.div>

      {/* Fee Info Section */}
      {feeInfo && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-lg border border-border bg-card p-5"
        >
          <h3 className="text-sm font-semibold mb-3">{t("feeInfo")}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            {Object.entries(feeInfo).map(([key, value]) => (
              <div key={key} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{key}</span>
                <span className="font-medium font-tabular">
                  {typeof value === "number"
                    ? value < 1
                      ? `${(value * 100).toFixed(1)}%`
                      : formatKRW(value)
                    : String(value)}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Detail Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="truncate">
              {selectedEvent?.title ?? t("eventDetail")}
            </SheetTitle>
            <SheetDescription>
              {selectedEvent?.venue}
              {selectedEvent?.event_date
                ? ` | ${selectedEvent.event_date.slice(0, 10)}`
                : ""}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-5">
            {/* Price Trend Chart */}
            <div>
              <h4 className="text-sm font-semibold mb-2">{t("priceTrend")}</h4>
              {tradingLoading ? (
                <div className="flex items-center justify-center h-[200px]">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                </div>
              ) : chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient
                        id="priceGrad"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor="#6366f1"
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="95%"
                          stopColor="#6366f1"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10 }}
                      stroke="#555"
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      stroke="#555"
                      tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#1a1a1a",
                        border: "1px solid #333",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value) => [formatKRW(Number(value)), t("price")]}
                    />
                    <Area
                      type="monotone"
                      dataKey="price"
                      stroke="#6366f1"
                      fill="url(#priceGrad)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
                  {t("noChartData")}
                </div>
              )}
            </div>

            {/* Tier Breakdown */}
            {selectedEvent && selectedEvent.tiers.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">{t("tierBreakdown")}</h4>
                <div className="space-y-2">
                  {selectedEvent.tiers.map((tier) => (
                    <div
                      key={tier.tier_id}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <div>
                        <span className="font-medium">{tier.tier_name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t("tierBasePrice", { price: formatKRW(tier.base_price) })}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs font-tabular">
                        <span>{t("tierListingCount", { count: tier.listing_count ?? 0 })}</span>
                        <span>
                          {t("tierLowest")}{" "}
                          {tier.lowest_ask != null ? formatKRW(tier.lowest_ask) : "-"}
                        </span>
                        <span>{t("tierBuyOrder", { count: tier.buy_order_count ?? 0 })}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trading Summary */}
            {tradingData?.summary && (
              <div>
                <h4 className="text-sm font-semibold mb-2">{t("tradingSummary")}</h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {Object.entries(tradingData.summary).map(([key, value]) => (
                    <div key={key} className="flex flex-col gap-0.5">
                      <span className="text-xs text-muted-foreground">
                        {key}
                      </span>
                      <span className="font-medium font-tabular">
                        {typeof value === "number"
                          ? formatKRW(value)
                          : String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent Trades */}
            {tradingData?.recent_trades &&
              tradingData.recent_trades.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">{t("recentTrades")}</h4>
                  <div className="divide-y divide-border rounded-md border border-border">
                    {tradingData.recent_trades
                      .slice(0, 10)
                      .map((trade, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between px-3 py-2 text-xs"
                        >
                          <span className="text-muted-foreground">
                            {trade.transferred_at
                              ? trade.transferred_at
                                  .slice(5, 16)
                                  .replace("T", " ")
                              : "-"}
                          </span>
                          <span className="font-tabular font-medium">
                            {formatKRW(trade.price)}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

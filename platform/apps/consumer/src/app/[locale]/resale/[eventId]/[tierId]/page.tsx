"use client";

import { useState, Suspense } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMarketStream } from "@/hooks/useMarketStream";
import { useOptimisticOrder } from "@/hooks/useOptimisticOrder";
import { useResaleStore } from "@/store/resale";
import { useAuthStore } from "@pickket/store";
import MarketHeader from "@/components/resale/MarketHeader";
import OrderBook from "@/components/resale/OrderBook";
import dynamic from "next/dynamic";
const PriceChart = dynamic(() => import("@/components/resale/PriceChart"), {
  ssr: false,
});
import TradeHistory from "@/components/resale/TradeHistory";
import OrderPanel from "@/components/resale/OrderPanel";
import ComplianceBadge from "@/components/resale/ComplianceBadge";
import CreateListingDialog from "@/components/resale/CreateListingDialog";
import MarketHeaderSkeleton from "@/components/resale/skeletons/MarketHeaderSkeleton";
import PriceChartSkeleton from "@/components/resale/skeletons/PriceChartSkeleton";
import OrderBookSkeleton from "@/components/resale/skeletons/OrderBookSkeleton";
import OrderPanelSkeleton from "@/components/resale/skeletons/OrderPanelSkeleton";
import TradeHistorySkeleton from "@/components/resale/skeletons/TradeHistorySkeleton";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

interface EligibleTicket {
  id: string;
  event_id: string;
  event_title: string;
  tier_name: string;
  original_price?: number;
}

export default function TradingPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const t = useTranslations("resale");
  const eventId = params.eventId as string;
  const tierId = params.tierId as string;

  // Sell flow state
  const [sellDialogOpen, setSellDialogOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<EligibleTicket | null>(
    null,
  );

  const { data, connected, reconnect } = useMarketStream(eventId, tierId);
  const {
    optimisticEntries,
    addOptimistic,
    confirmOptimistic,
    failOptimistic,
  } = useOptimisticOrder();
  const setMarket = useResaleStore((s) => s.setMarket);

  // Set market on mount
  const [marketSet, setMarketSet] = useState(false);
  if (!marketSet) {
    setMarket(eventId, tierId);
    setMarketSet(true);
  }

  // Fetch event + tier metadata
  const { data: metaData } = useQuery({
    queryKey: ["resale", "meta", eventId, tierId],
    queryFn: async () => {
      const { getEvent, default: apiClient } = await import("@pickket/lib/api");
      const [eventRes, tiersRes] = await Promise.allSettled([
        getEvent(eventId),
        apiClient.get(`/events/${eventId}/tiers`),
      ]);
      const eventTitle =
        eventRes.status === "fulfilled"
          ? (eventRes.value.data?.title ?? "")
          : "";
      let tierName: string | undefined;
      let facePrice = 0;
      if (tiersRes.status === "fulfilled") {
        const tier = tiersRes.value.data?.find(
          (t: { id: string }) => t.id === tierId,
        );
        if (tier) {
          tierName = tier.name;
          facePrice = tier.face_price ?? tier.base_price ?? 0;
        }
      }
      return { eventTitle, tierName, facePrice };
    },
  });

  const eventTitle = metaData?.eventTitle ?? t("market");
  const tierName = metaData?.tierName;
  const facePrice = metaData?.facePrice ?? 0;

  const handleBuy = async (price: number) => {
    if (!user) {
      router.push("/auth");
      return;
    }
    try {
      const { createResaleBuyOrder } = await import("@pickket/lib/api");
      await createResaleBuyOrder({
        event_id: eventId,
        tier_id: tierId,
        max_price: price,
      });
      toast.success(t("buyOrderPlaced"));
    } catch (err: unknown) {
      toast.error(
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("orderFailed"),
      );
    }
  };

  const handleSell = async (_price: number) => {
    if (!user) {
      router.push("/auth");
      return;
    }
    try {
      const { getMyTickets } = await import("@pickket/lib/api");
      const res = await getMyTickets(0, 200);
      const allTickets = res.data?.tickets ?? [];
      const eligible = allTickets
        .filter(
          (tk) =>
            tk.event_id === eventId &&
            tk.tier_id === tierId &&
            tk.status === "active" &&
            tk.is_resalable,
        )
        .map((tk) => ({
          id: tk.id,
          event_id: tk.event_id,
          event_title: eventTitle,
          tier_name: tk.tier_name ?? tierName ?? "",
          original_price: tk.purchase_price ?? facePrice,
        }));

      if (eligible.length === 0) {
        toast.info(t("noEligibleTickets"));
        return;
      }

      setSelectedTicket(eligible[0]);
      setSellDialogOpen(true);
    } catch {
      toast.error(t("ticketLoadFailed"));
    }
  };

  const summary = data?.summary || {
    current_price: null,
    price_change: 0,
    price_change_pct: 0,
    day_high: null,
    day_low: null,
    day_volume: 0,
    total_listings: 0,
    total_buy_orders: 0,
  };

  return (
    <main className="bg-background min-h-screen pt-20">
      {/* Back navigation */}
      <div className="bg-card border-b border-white/8 px-4 py-2">
        <nav className="flex items-center gap-2 text-xs">
          <Link
            href="/sell"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("market")}
          </Link>
          <span className="text-muted-foreground">|</span>
          <Link
            href={`/events/${eventId}`}
            className="text-muted-foreground hover:text-foreground transition-colors truncate max-w-[250px]"
          >
            {t("eventDetail")}
          </Link>
        </nav>
      </div>

      {/* Compliance Badge */}
      <div className="px-4 pt-2">
        <ComplianceBadge variant="banner" />
      </div>

      {/* Market Header */}
      <Suspense fallback={<MarketHeaderSkeleton />}>
        <MarketHeader
          summary={summary}
          eventTitle={eventTitle}
          tierName={tierName}
          connected={connected}
          onReconnect={reconnect}
        />
      </Suspense>

      {/* Main Grid */}
      <div className="max-w-[1400px] mx-auto p-3 md:p-4">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          {/* Right: Order Panel -- mobile first via order-first */}
          <div className="order-first lg:order-3 lg:col-span-4 min-h-[360px]">
            <Suspense fallback={<OrderPanelSkeleton />}>
              <OrderPanel
                summary={summary}
                eventTitle={eventTitle}
                tierName={tierName}
                originalPrice={facePrice}
                onSubmitBuy={handleBuy}
                onSubmitSell={handleSell}
                onOptimisticAdd={addOptimistic}
                onOptimisticConfirm={confirmOptimistic}
                onOptimisticFail={failOptimistic}
              />
            </Suspense>
          </div>

          {/* Left: Chart */}
          <div className="lg:order-1 lg:col-span-5 min-h-[360px]">
            <Suspense fallback={<PriceChartSkeleton />}>
              <PriceChart candles={data?.candles || []} />
            </Suspense>
          </div>

          {/* Center: Order Book */}
          <div className="lg:order-2 lg:col-span-3 min-h-[360px]">
            <Suspense fallback={<OrderBookSkeleton />}>
              <OrderBook
                askLevels={data?.ask_levels || []}
                bidLevels={data?.bid_levels || []}
                optimisticEntries={optimisticEntries}
              />
            </Suspense>
          </div>

          {/* Bottom: Trade History (full width) */}
          <div className="lg:order-4 lg:col-span-12">
            <Suspense fallback={<TradeHistorySkeleton />}>
              <TradeHistory trades={data?.recent_trades || []} />
            </Suspense>
          </div>
        </div>
      </div>

      {/* CreateListingDialog for sell flow */}
      {selectedTicket && (
        <CreateListingDialog
          open={sellDialogOpen}
          onOpenChange={setSellDialogOpen}
          ticket={selectedTicket}
          onSuccess={() => {
            setSellDialogOpen(false);
            setSelectedTicket(null);
          }}
        />
      )}
    </main>
  );
}

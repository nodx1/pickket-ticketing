"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import Image from "next/image";
import {
  MapPin,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Layers,
  ArrowRight,
  ShoppingBag,
} from "lucide-react";
import { Badge } from "@pickket/ui";
import { type ResaleEventInfo } from "@pickket/lib/api";
import { CATEGORIES, formatKRW } from "@pickket/lib";
import PickketScore from "./PickketScore";
import MiniSparkline from "./MiniSparkline";

interface ResaleEventCardProps {
  event: ResaleEventInfo;
  isExpanded: boolean;
  onToggleExpand: () => void;
  isDemo?: boolean;
}

function getLowestAsk(ev: ResaleEventInfo): number | null {
  const asks = ev.tiers
    .map((t) => t.lowest_ask)
    .filter((a): a is number => a !== null);
  return asks.length > 0 ? Math.min(...asks) : null;
}

function getAvgFacePrice(ev: ResaleEventInfo): number {
  if (ev.tiers.length === 0) return 0;
  const total = ev.tiers.reduce((s, t) => s + t.base_price, 0);
  return Math.round(total / ev.tiers.length);
}

function generateSparklineData(
  facePrice: number,
  currentAsk: number | null,
): number[] {
  if (!currentAsk) return [];
  const points: number[] = [];
  const range = currentAsk - facePrice;
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    points.push(facePrice + range * t * (0.7 + Math.random() * 0.6));
  }
  points[6] = currentAsk;
  return points;
}

export default function ResaleEventCard({
  event: ev,
  isExpanded,
  onToggleExpand,
}: ResaleEventCardProps) {
  const t = useTranslations("resale");
  const lowestAsk = getLowestAsk(ev);
  const totalListings = ev.tiers.reduce((s, t) => s + t.listing_count, 0);
  const avgFace = getAvgFacePrice(ev);

  const [sparklineData] = useState(() =>
    generateSparklineData(avgFace, lowestAsk),
  );

  const priceChangePct =
    avgFace > 0 && lowestAsk !== null
      ? ((lowestAsk - avgFace) / avgFace) * 100
      : 0;

  const totalBuyOrders = ev.tiers.reduce((s, t) => s + t.buy_order_count, 0);

  function formatEventDate(dateStr: string | null): string {
    if (!dateStr) return t("dateUndecided");
    try {
      return new Date(dateStr).toLocaleDateString("ko-KR", {
        month: "long",
        day: "numeric",
        weekday: "short",
      });
    } catch {
      return t("dateUndecided");
    }
  }

  return (
    <div
      className={`rounded-2xl shadow-sm bg-card overflow-hidden transition-all duration-300 hover:shadow-lg ${
        isExpanded ? "ring-2 ring-primary/20" : ""
      }`}
    >
      <button
        className="w-full text-left"
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
      >
        <div className="relative w-full aspect-[16/9] bg-muted overflow-hidden">
          {ev.image_url ? (
            <Image
              src={ev.image_url}
              alt={ev.title}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <ShoppingBag className="h-10 w-10 text-muted-foreground/20" />
            </div>
          )}
          <div className="absolute top-3 left-3">
            <Badge
              variant="secondary"
              className="bg-black/50 text-white border-none text-xs-plus backdrop-blur-sm"
            >
              {CATEGORIES.find((c) => c.slug === ev.category)?.label ??
                ev.category}
            </Badge>
          </div>
          {totalListings > 0 && (
            <div className="absolute top-3 right-3">
              <Badge className="bg-cyan text-white border-none text-xs-plus">
                {t("ticketsOnSale", { count: totalListings })}
              </Badge>
            </div>
          )}
        </div>

        <div className="p-4">
          <h3 className="text-base font-bold text-foreground line-clamp-1 mb-1">
            {ev.title}
          </h3>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {ev.venue}
            </span>
            <span className="flex items-center gap-1">
              <CalendarDays className="h-3 w-3" />
              {formatEventDate(ev.event_date)}
            </span>
          </div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs-plus text-muted-foreground/70">
                {t("lowestAsk")}
              </p>
              <p className="text-lg font-bold text-primary font-tabular">
                {lowestAsk ? formatKRW(lowestAsk) : "—"}
              </p>
            </div>
            {sparklineData.length >= 2 && (
              <MiniSparkline data={sparklineData} />
            )}
          </div>
          <div className="flex items-center justify-between">
            <PickketScore
              input={{
                currentAskPrice: lowestAsk,
                facePrice: avgFace,
                priceChangePct,
                eventDate: ev.event_date,
                totalListings,
                totalBuyOrders,
              }}
              variant="compact"
            />
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Layers className="h-3.5 w-3.5" />
              {t("tierCount", { count: ev.tiers.length })}
              {isExpanded ? (
                <ChevronUp className="h-3.5 w-3.5 ml-1" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 ml-1" />
              )}
            </div>
          </div>
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-2 animate-in slide-in-from-top-2 duration-200">
          <p className="text-xs font-semibold text-muted-foreground mb-1">
            {t("tierResaleStatus")}
          </p>
          {ev.tiers.map((tier) => (
            <Link
              key={tier.tier_id}
              href={`/resale/${ev.event_id}/${tier.tier_id}`}
              className="flex items-center justify-between rounded-xl bg-surface-dim hover:bg-secondary px-4 py-3 transition-colors group"
            >
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {tier.tier_name}
                </p>
                <p className="text-xs text-muted-foreground font-tabular">
                  {t("facePriceLabel")} {formatKRW(tier.base_price)} &middot;{" "}
                  {t("ticketsOnSale", { count: tier.listing_count })}
                </p>
              </div>
              <div className="text-right flex items-center gap-2">
                <div>
                  <p className="text-sm font-bold text-primary font-tabular">
                    {tier.lowest_ask ? formatKRW(tier.lowest_ask) : "—"}
                  </p>
                  {tier.buy_order_count > 0 && (
                    <p className="text-xs-plus text-cyan">
                      {t("buyersWaiting", { count: tier.buy_order_count })}
                    </p>
                  )}
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary transition-colors" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

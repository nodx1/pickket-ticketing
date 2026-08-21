"use client";

import { MapPin, Bell, Ticket, Clock, Shield } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatKRW } from "@pickket/lib";
import type { EventDetail } from "@pickket/lib/api";
import { CARD } from "@/lib/styles";

/* ── Default neon tier colors (실제 tier 가 없을 때 폴백) ────────────────── */
const DEFAULT_TIER_PRESETS = [
  {
    name: "VIP",
    color: "#7B61FF",
    glow: "rgba(123,97,255,0.4)",
    cols: 8,
    rows: 1,
    shape: "circle" as const,
  },
  {
    name: "R석",
    color: "#FFD700",
    glow: "rgba(255,215,0,0.35)",
    cols: 6,
    rows: 2,
    shape: "circle" as const,
  },
  {
    name: "S석",
    color: "#01f5a0",
    glow: "rgba(1,245,160,0.35)",
    cols: 12,
    rows: 2,
    shape: "circle" as const,
  },
  {
    name: "A석",
    color: "#00D1FF",
    glow: "rgba(0,209,255,0.35)",
    cols: 14,
    rows: 2,
    shape: "circle" as const,
  },
  {
    name: "B석",
    color: "#FF00FF",
    glow: "rgba(255,0,255,0.3)",
    cols: 10,
    rows: 1,
    shape: "square" as const,
  },
];

/** 실제 이벤트 products (tier) 기반으로 preview 데이터 구성. */
function buildTiersFromEvent(event: EventDetail) {
  const products = (
    event as unknown as {
      products?: Array<{
        name: string;
        capacity?: number;
        color_hex?: string | null;
      }>;
    }
  ).products;
  if (!Array.isArray(products) || products.length === 0)
    return DEFAULT_TIER_PRESETS;

  const colors = [
    "#7B61FF",
    "#FFD700",
    "#01f5a0",
    "#00D1FF",
    "#FF00FF",
    "#FF6B6B",
  ];
  return products.map((p, i) => {
    const color = p.color_hex || colors[i % colors.length];
    // 대략적 시각화 — 실제 capacity 에 비례해서 격자 크기 결정
    const capacity = Math.max(8, p.capacity ?? 24);
    const cols = Math.min(14, Math.max(6, Math.ceil(Math.sqrt(capacity * 2))));
    const rows = Math.max(1, Math.ceil(capacity / cols));
    return {
      name: p.name,
      color,
      glow: `${color}55`,
      cols,
      rows,
      shape: "circle" as const,
    };
  });
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function generateSeats(
  cols: number,
  rows: number,
  tierName: string,
  soldRatio = 0.15,
) {
  const seats: ("available" | "sold")[] = [];
  const total = cols * rows;
  for (let i = 0; i < total; i++) {
    const h = simpleHash(`${tierName}-seat-${i}`) % 100;
    seats.push(h < soldRatio * 100 ? "sold" : "available");
  }
  return seats;
}

function estimateTierPrice(
  minPrice: number,
  maxPrice: number | null,
  index: number,
  total: number,
) {
  const max = maxPrice ?? minPrice * 2.5;
  if (total <= 1) return minPrice;
  const ratio = 1 - index / (total - 1);
  return Math.round((minPrice + (max - minPrice) * ratio) / 1000) * 1000;
}

interface SeatGuidePreviewProps {
  event: EventDetail;
  onNotify?: () => void;
}

export function SeatGuidePreview({ event, onNotify }: SeatGuidePreviewProps) {
  const t = useTranslations("event.seatGuidePreview");
  const minPrice = event.min_price ?? 0;
  const maxPrice = event.max_price ?? null;
  const TIER_PRESETS = buildTiersFromEvent(event);

  return (
    <div className={CARD.shell}>
      {/* Header */}
      <div className="px-6 py-5 border-b border-border bg-background/50 flex items-center justify-between">
        <h2 className="flex items-center gap-2.5 text-lg font-bold text-foreground">
          <MapPin className="h-5 w-5 text-primary" />
          {t("title")}
        </h2>
        <span className="text-xs font-medium text-muted-foreground">
          {event.venue ?? t("venueTbd")}
        </span>
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Left: Seat map visualization */}
        <div className="flex-1 p-6 md:p-8 bg-background/40 flex flex-col items-center">
          {/* Stage */}
          <div className="w-full max-w-md h-10 bg-gradient-to-b from-primary/30 to-transparent rounded-t-[100%] mb-8 flex items-center justify-center">
            <span className="text-2xs font-bold uppercase tracking-[0.4em] text-primary/70">
              Main Stage
            </span>
          </div>

          {/* Seat sections */}
          <div className="flex flex-col items-center gap-8 w-full max-w-md">
            {TIER_PRESETS.map((tier, _tierIdx) => {
              const seats = generateSeats(tier.cols, tier.rows, tier.name);
              return (
                <div
                  key={tier.name}
                  className="flex flex-col items-center gap-2.5"
                >
                  <span
                    className="text-2xs font-bold tracking-[0.2em] uppercase"
                    style={{ color: tier.color }}
                  >
                    {tier.name}
                  </span>
                  <div
                    className="grid gap-2"
                    style={{
                      gridTemplateColumns: `repeat(${tier.cols}, minmax(0, 1fr))`,
                    }}
                  >
                    {seats.map((status, i) => (
                      <div
                        key={`${tier.name}-${i}`}
                        className={`w-3 h-3 ${tier.shape === "circle" ? "rounded-full" : "rounded-sm"} transition-all ${
                          status === "sold" ? "opacity-20" : ""
                        }`}
                        style={{
                          backgroundColor:
                            status === "sold" ? "#35333e" : tier.color,
                          boxShadow:
                            status === "available"
                              ? `0 0 4px ${tier.glow}`
                              : "none",
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Disclaimer */}
          <p className="mt-8 text-2xs text-muted-foreground/60 text-center">
            {t("disclaimer")}
          </p>
        </div>

        {/* Right: Legend + Info sidebar */}
        <aside className="w-full md:w-72 p-6 bg-background/30 border-t md:border-t-0 md:border-l border-border flex flex-col gap-6">
          {/* Seat status legend */}
          <div>
            <h4 className="text-2xs font-bold uppercase tracking-[0.2em] text-muted-foreground/60 mb-3">
              Seat Legend
            </h4>
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 rounded-full bg-white" />
                <span className="text-xs font-medium text-muted-foreground">
                  {t("legendAvailable")}
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 rounded-full border-2 border-white shadow-[0_0_6px_white]" />
                <span className="text-xs font-medium text-muted-foreground">
                  {t("legendSelected")}
                </span>
              </div>
              <div className="flex items-center gap-2.5 opacity-40">
                <div className="w-2.5 h-2.5 rounded-full bg-card" />
                <span className="text-xs font-medium text-muted-foreground">
                  {t("legendSoldOut")}
                </span>
              </div>
            </div>
          </div>

          {/* Tier pricing */}
          <div>
            <h4 className="text-2xs font-bold uppercase tracking-[0.2em] text-muted-foreground/60 mb-4">
              {t("tierPricingTitle")}
            </h4>
            <div className="flex flex-col gap-3">
              {TIER_PRESETS.map((tier, idx) => {
                const price = estimateTierPrice(
                  minPrice,
                  maxPrice,
                  idx,
                  TIER_PRESETS.length,
                );
                return (
                  <div
                    key={tier.name}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{
                          backgroundColor: tier.color,
                          boxShadow: `0 0 6px ${tier.glow}`,
                        }}
                      />
                      <span className="text-xs font-semibold text-foreground">
                        {tier.name}
                      </span>
                    </div>
                    <span
                      className="text-xs-plus font-bold font-tabular"
                      style={{ color: tier.color }}
                    >
                      {formatKRW(price)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Info cards */}
          <div className="pt-4 border-t border-border flex flex-col gap-3">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0 text-primary" />
              <span className="text-xs">{t("infoFairDraw")}</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <Shield className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="text-xs">{t("infoSecurePayment")}</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <Ticket className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
              <span className="text-xs">
                {t("infoTotalSeats", { count: event.total_seats ?? 0 })}
              </span>
            </div>
          </div>

          {/* CTA */}
          {onNotify && (
            <button
              onClick={onNotify}
              className="w-full mt-2 inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full font-bold text-sm bg-primary text-white shadow-sm hover:brightness-110 active:scale-95 transition-all"
            >
              <Bell className="h-4 w-4" />
              {t("ctaNotify")}
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}

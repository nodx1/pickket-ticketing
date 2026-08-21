import HomeContent from "./HomeContent";
import type { HomePageEvent } from "@/components/home/types";
import type { FanRequestArtist } from "@/components/home/types";
import { API_URL } from "@pickket/lib";
import { getTranslations } from "next-intl/server";

export const revalidate = 300; // ISR 5분 (이벤트 목록은 자주 변경되지 않음)

type ApiEvent = Record<string, unknown>;

function toNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function formatEventDate(value: string, fallbackLabel: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return fallbackLabel;

  const formatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";

  return `${month}.${day} (${weekday}) ${hour}:${minute}`;
}

function formatCountdown(value: string, inProgressLabel: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  const diffMs = date.getTime() - Date.now();

  if (diffMs <= 0) return inProgressLabel;

  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  return `D-${diffDays}`;
}

function buildHomeEvents(
  rawEvents: ApiEvent[],
  labels: {
    eventDateFallback: string;
    inProgress: string;
    noTitle: string;
    venueFallback: string;
  },
): HomePageEvent[] {
  return rawEvents.map((event, index) => ({
    id: String(event.id ?? `event-${index}`),
    title: String(event.title ?? labels.noTitle),
    thumbnail_url: String(event.thumbnail_url || event.image_url || ""),
    event_date: String(event.event_date ?? ""),
    event_date_label: formatEventDate(String(event.event_date ?? ""), labels.eventDateFallback),
    countdown_label: formatCountdown(String(event.event_date ?? ""), labels.inProgress),
    venue_name:
      String(
        event.venue || event.location_city || event.organizer_name || "",
      ) || labels.venueFallback,
    min_price: Math.max(toNumber(event.min_price, 0), 0),
    bid_count: toNumber(event.bid_count, 0),
    total_seats: toNumber(event.total_seats, 0),
    is_featured: Boolean(event.is_featured),
    primary_sale_mode: String(event.primary_sale_mode || "") || null,
  }));
}

async function fetchJSON(path: string): Promise<unknown[]> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data.items || data.events || [];
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const t = await getTranslations("home.page");
  const labels = {
    eventDateFallback: t("eventDateFallback"),
    inProgress: t("inProgress"),
    noTitle: t("noTitle"),
    venueFallback: t("venueFallback"),
  };

  const [trendingRaw, featuredRaw, fanRequestRaw] = await Promise.all([
    fetchJSON("/api/v1/events/trending"),
    fetchJSON("/api/v1/events/featured"),
    fetchJSON("/api/v1/fan-requests/ranking"),
  ]);

  const trendingSource = trendingRaw as ApiEvent[];
  const featuredSource = (
    featuredRaw.length
      ? featuredRaw
      : trendingRaw.length
        ? trendingRaw.slice(0, 1)
        : []
  ) as ApiEvent[];

  const trendingEvents = buildHomeEvents(trendingSource, labels);
  const featuredEvents = buildHomeEvents(featuredSource, labels).map((event) => ({
    ...event,
    is_featured: true,
  }));

  // Event 타입으로 캐스팅 (EventCardUnified용)
  const trendingAsEvents = trendingSource.map((e) => ({
    id: String(e.id ?? ""),
    title: String(e.title ?? ""),
    image_url: String(e.image_url ?? ""),
    image_variants: { thumb_md: String(e.thumbnail_url || e.image_url || "") },
    venue: String(e.venue ?? ""),
    event_date: String(e.event_date ?? ""),
    category: String(e.category ?? ""),
    status: String(e.status ?? ""),
    min_price: toNumber(e.min_price, 0),
    bid_count: toNumber(e.bid_count, 0),
    total_seats: toNumber(e.total_seats, 0),
    comment_count: toNumber(e.comment_count, 0),
    location_city: String(e.location_city ?? ""),
    is_featured: Boolean(e.is_featured),
    is_free: Boolean(e.is_free),
    is_public_sector: Boolean(e.is_public_sector),
    currency: "KRW",
    sale_mode: String(e.primary_sale_mode ?? ""),
    bidding_closes_at: e.bidding_closes_at ? String(e.bidding_closes_at) : null,
    blurhash: e.blurhash ? String(e.blurhash) : undefined,
  })) as unknown as import("@pickket/lib/api").Event[];

  return (
    <HomeContent
      trendingEvents={trendingEvents}
      featuredEvents={featuredEvents}
      trendingRaw={trendingAsEvents}
      fanRequests={(fanRequestRaw as Record<string, unknown>[]).map(
        (r) =>
          ({
            id: String(r.id ?? ""),
            name: String(r.name ?? ""),
            image: String(r.image_url ?? ""),
            genre: String(r.genre ?? ""),
            requests: toNumber(r.request_count, 0),
            isLive: Boolean(r.is_live),
            userRequested: Boolean(r.user_requested),
          }) satisfies FanRequestArtist,
      )}
    />
  );
}

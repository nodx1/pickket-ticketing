export interface EventItem {
  id: string;
  title: string;
  artist: string;
  venue: string;
  date: string;
  price: number;
  originalPrice: number | null;
  discount: number | null;
  category: string;
  bidCount: number;
  totalSeats: number;
  rating: number;
  reviewCount: number;
  demand: "HIGH" | "MEDIUM" | "LOW";
  heroImg: string;
  posterImg: string;
  thumbImg: string;
  timeLeft: string | null;
  isFeatured: boolean;
}

export interface RankingItem {
  rank: number;
  title: string;
  change: "up" | "down" | "new" | "same";
  changeVal: number;
  bidders: number;
}

export interface HomeContentProps {
  trendingEvents: HomePageEvent[];
  featuredEvents: HomePageEvent[];
  trendingRaw?: import("@pickket/lib/api").Event[];
  fanRequests?: FanRequestArtist[];
}

export interface OpenNotice {
  id: string;
  title: string;
  date: string;
  dDay: string;
  exclusive: boolean;
}

export function fmt(n: number) {
  return n.toLocaleString("ko-KR");
}

export { CATEGORY_LABELS, SALE_MODE_LABELS } from "@pickket/lib/constants";

export const DEMAND_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  HIGH: {
    bg: "bg-red-500",
    text: "text-primary-foreground",
    label: "수요 폭발",
  },
  MEDIUM: {
    bg: "bg-amber-500",
    text: "text-primary-foreground",
    label: "인기",
  },
  LOW: { bg: "bg-sky-500", text: "text-primary-foreground", label: "여유" },
};

export interface HomePageEvent {
  id: string;
  title: string;
  thumbnail_url: string;
  event_date: string;
  event_date_label: string;
  countdown_label: string | null;
  venue_name: string;
  min_price: number;
  /** 실제 API 응답 bid_count (합성 금지) */
  bid_count: number;
  /** 실제 API 응답 total_seats (합성 금지) */
  total_seats: number;
  is_featured: boolean;
  primary_sale_mode: string | null;
}

export interface FanRequestArtist {
  id: string;
  name: string;
  image: string;
  genre: string;
  requests: number;
  isLive: boolean;
  userRequested?: boolean;
}

export function fmtPrice(n: number) {
  return `₩${fmt(n)}`;
}

/** @deprecated mileage_multiplier 제거 — 사용처 없음 */

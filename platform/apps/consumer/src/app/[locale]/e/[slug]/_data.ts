/**
 * /e/[slug] — Event Open 랜딩 페이지 데이터 레이어
 *
 * GET /api/v1/events/by-slug/:slug → EventOpenData
 * 프로토타입 목업은 fallback으로 유지 (개발/디자인 편의).
 */

import { API_URL } from "@pickket/lib";

export type EventOpenData = {
  id: string;
  slug: string;
  title: string;
  venue: string;
  heroImage: string;
  imageVariants: Record<string, string> | null;
  ticketOpenAt: string | null; // ISO 8601, = desired_open_date
  brandColor: string;
  brandColorFg: string;
  category: string;
  artistName: string | null;
  locationCity: string | null;
  status: string;
  serviceFeeRate: number;
  subscriberCount: number;
};

/** API 응답 (snake_case) → 컴포넌트 타입 (camelCase) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromApi(raw: Record<string, any>): EventOpenData {
  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    venue: raw.venue,
    heroImage: raw.image_url ?? "",
    imageVariants: raw.image_variants ?? null,
    ticketOpenAt: raw.ticket_open_at ?? null,
    brandColor: raw.brand_color ?? "#FF3366",
    brandColorFg: raw.brand_color_fg ?? "#FFFFFF",
    category: raw.category ?? "CONCERT",
    artistName: raw.artist_name ?? null,
    locationCity: raw.location_city ?? null,
    status: raw.status,
    serviceFeeRate: raw.service_fee_rate ?? 0.11,
    subscriberCount: raw.subscriber_count ?? 0,
  };
}

// Design-time fallback (slug이 DB에 없을 때만 사용)
const MOCK_EVENTS: Record<string, EventOpenData> = {
  "tyler-the-creator-seoul-2026": {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "tyler-the-creator-seoul-2026",
    title: "Tyler, The Creator Seoul 2026",
    venue: "블루스퀘어 마스터카드홀",
    heroImage:
      "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=1600&q=80",
    imageVariants: null,
    ticketOpenAt: new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000,
    ).toISOString(),
    brandColor: "#FF3366",
    brandColorFg: "#FFFFFF",
    category: "CONCERT",
    artistName: "Tyler, The Creator",
    locationCity: "서울",
    status: "approved",
    serviceFeeRate: 0.11,
    subscriberCount: 1247,
  },
  "indie-summer-festival-2026": {
    id: "22222222-2222-2222-2222-222222222222",
    slug: "indie-summer-festival-2026",
    title: "2026 인디 썸머 페스티벌",
    venue: "올림픽공원 88잔디마당",
    heroImage:
      "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=1600&q=80",
    imageVariants: null,
    ticketOpenAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    brandColor: "#00D4FF",
    brandColorFg: "#0A0A0A",
    category: "FESTIVAL",
    artistName: null,
    locationCity: "서울",
    status: "approved",
    serviceFeeRate: 0.11,
    subscriberCount: 382,
  },
};

export async function getEventOpenBySlug(
  slug: string,
): Promise<EventOpenData | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/events/by-slug/${slug}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) {
      // 개발 환경에서만 mock fallback
      if (process.env.NODE_ENV === "development")
        return MOCK_EVENTS[slug] ?? null;
      return null;
    }
    return fromApi(await res.json());
  } catch {
    // API 미응답 시 fallback (개발 환경만)
    if (process.env.NODE_ENV === "development")
      return MOCK_EVENTS[slug] ?? null;
    return null;
  }
}

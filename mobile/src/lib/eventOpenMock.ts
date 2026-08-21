/**
 * /e/[slug] 모바일 프로토타입 목업 데이터
 * Consumer 웹의 _data.ts와 동일 구조 유지.
 * S3에서 실제 v2 API(/events/by-slug/:slug)로 교체 예정.
 */

export type EventOpenData = {
  id: string;
  slug: string;
  title: string;
  venue: string;
  heroImage: string;
  ticketOpenAt: string;
  brandColor: string;
  brandColorFg: string;
  subscriberCount: number;
};

const MOCK: Record<string, EventOpenData> = {
  "tyler-the-creator-seoul-2026": {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "tyler-the-creator-seoul-2026",
    title: "Tyler, The Creator Seoul 2026",
    venue: "블루스퀘어 마스터카드홀",
    heroImage:
      "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=1200&q=80",
    ticketOpenAt: new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000,
    ).toISOString(),
    brandColor: "#FF3366",
    brandColorFg: "#FFFFFF",
    subscriberCount: 1247,
  },
  "indie-summer-festival-2026": {
    id: "22222222-2222-2222-2222-222222222222",
    slug: "indie-summer-festival-2026",
    title: "2026 인디 썸머 페스티벌",
    venue: "올림픽공원 88잔디마당",
    heroImage:
      "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=1200&q=80",
    ticketOpenAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    brandColor: "#00D4FF",
    brandColorFg: "#0A0A0A",
    subscriberCount: 382,
  },
};

export function getEventOpenMock(slug: string): EventOpenData | null {
  return MOCK[slug] ?? null;
}

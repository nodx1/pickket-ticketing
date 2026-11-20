import type { EventProgramData } from "@pickket/lib/api";

export interface EventInfoTabsEvent {
  description?: string | null;
  artist_name?: string | null;
  subject_name?: string | null;
  category?: string | null;
  venue?: string | null;
  location_city?: string | null;
  duration_minutes?: number | null;
  age_restriction?: string | null;
  // 상세통합 트랙B U1 — go 정본 필드. NULL/빈값·false 시 미노출(비파괴).
  age_rating?: string | null; // 관람연령(go 정본, age_restriction 우선)
  venue_address?: string | null; // 공연장 주소
  // 지도 API 연동(과업지시서 2-1) — 주최사가 「장소 찾기」로 고른 좌표. 둘 다 있을 때만 지도를 그린다.
  venue_lat?: number | null;
  venue_lng?: number | null;
  is_online?: boolean | null; // 온라인 이벤트 여부
  homepage_url?: string | null; // 공식 홈페이지
  tags?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  broadcast_url?: string | null;
  broadcast_platform?: string | null;
  parking_info?: string | null;
  match_status?: string | null;
  program_notes?: string | null;
  program_data?: EventProgramData;
  event_date?: string | null;
  event_date_end?: string | null;
  stage_info?: string | null;
}

export interface FaqItem {
  id: string;
  summary: string;
  content?: string;
  useDescription?: boolean;
}

export function formatPeriod(startDate?: string, endDate?: string): string {
  if (!startDate || !endDate) return "";
  // KST 강제 변환 — SSR/client timezone mismatch 방지
  const toKst = (iso: string) =>
    new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const start = toKst(startDate);
  const end = toKst(endDate);
  const diffDays = Math.ceil(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  );
  const fmt = (date: Date) => `${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
  // 레벨2 컷오버(W2-EVT): 단일일 이벤트도 이제 event_date_end 가 항상 채워진다
  // (go `events.ends_at` NOT NULL 이라 안 채우면 go DB 삭제 시 종료일시가 비가역 소실).
  // 같은 날이면 "8.1 ~ 8.1 (1일간)" 대신 기간 표기를 만들지 않는다 — 호출측이 빈 문자열로
  // 판정해 기간 블록 자체를 렌더하지 않게 한다.
  if (fmt(start) === fmt(end) && start.getUTCFullYear() === end.getUTCFullYear()) {
    return "";
  }
  return `${fmt(start)} ~ ${fmt(end)} (${diffDays}일간)`;
}

export function getFaqItems(verifyMessage: string): FaqItem[] {
  return [
    {
      id: "method",
      summary: "예매 방법",
      useDescription: true,
    },
    {
      id: "cancel",
      summary: "취소/환불",
      content:
        "배분 전까지 응모 취소 가능합니다. 배분 완료 후에는 취소가 불가합니다.",
    },
    {
      id: "identity",
      summary: "본인 확인",
      content: verifyMessage,
    },
    {
      id: "fee",
      summary: "수수료 안내",
      content:
        "수수료는 결제 시 명확히 안내됩니다. 표시된 가격에 부가세가 포함되어 있습니다.",
    },
  ];
}


/**
 * 관람연령 코드 → 화면 문구. 피켓고는 코드(all, 7+, 12+, 15+, 18+)로 저장하고, 「직접 입력」은
 * 주최사가 쓴 문구 그대로 온다. 예전에는 코드가 그대로 보여 「관람등급: all」처럼 나왔다.
 */
const AGE_RATING_LABELS: Record<string, { ko: string; en: string }> = {
  all: { ko: "전체관람가", en: "All ages" },
  "7+": { ko: "만 7세 이상", en: "Ages 7+" },
  "12+": { ko: "12세 이상", en: "Ages 12+" },
  "15+": { ko: "15세 이상", en: "Ages 15+" },
  "18+": { ko: "청소년관람불가", en: "Adults only (18+)" },
};

export function ageRatingLabel(value: string, locale: string): string {
  const hit = AGE_RATING_LABELS[value.trim().toLowerCase()];
  if (!hit) return value;
  return locale === "ko" ? hit.ko : hit.en;
}

/**
 * 지도 API 연동(과업지시서 2-1) — 장소 좌표. 둘 다 숫자이고 범위 안일 때만 돌려준다
 * (한쪽만 있거나 잘못된 값이면 지도를 엉뚱한 곳에 찍으므로 그리지 않는다).
 */
export function venueCoordsOf(
  event: Pick<EventInfoTabsEvent, "venue" | "venue_lat" | "venue_lng">,
): { lat: number; lng: number; name: string } | null {
  const { venue_lat: lat, venue_lng: lng } = event;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, name: event.venue?.trim() || "이벤트 장소" };
}

/** 좌표 주변 오픈스트리트맵 임베드 주소(가운데 핀). 지도 라이브러리·키 없이 iframe 으로 그린다. */
export function osmEmbedUrl(lat: number, lng: number, span = 0.004): string {
  const dLat = span * 0.6;
  const bbox = [lng - span, lat - dLat, lng + span, lat + dLat].map((v) => v.toFixed(6)).join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

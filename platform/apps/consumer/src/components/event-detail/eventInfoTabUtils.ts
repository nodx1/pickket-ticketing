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

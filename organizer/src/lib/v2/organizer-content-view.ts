/**
 * 레벨2 W5-CONTENT — v2 콘텐츠 행 → go 대시보드 화면 계약 매핑.
 *
 * 라우트 파일(route.ts)은 Next.js 가 허용한 HTTP 메서드만 export 할 수 있어 공용 매퍼를
 * 여기에 둔다. 화면 쪽 필드명(camelCase 일부)은 **기존 계약 그대로** 유지한다 —
 * 이관은 저장 위치를 바꾸는 일이지 화면 계약을 바꾸는 일이 아니다.
 */
import type {
  OrganizerFacilityRow,
  OrganizerNoticeRow,
  OrganizerParticipantRow,
} from "@/lib/v2/commerce-client";

/** 공지: 화면은 `type`/`isPublished`/`publishedAt`/`createdAt` 을 읽는다. */
export function toClientNotice(n: OrganizerNoticeRow) {
  return {
    id: n.id,
    type: n.notice_type,
    title: n.title,
    content: n.content,
    isPublished: n.is_published,
    publishedAt: n.published_at,
    createdAt: n.created_at,
  };
}

/** 출연진: 화면 계약이 snake_case(`image_url`/`sort_order`/`is_visible`)라 그대로 둔다. */
export function toClientParticipant(p: OrganizerParticipantRow) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    bio: p.bio,
    image_url: p.image_url,
    sort_order: p.sort_order,
    is_visible: p.is_visible,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

/**
 * 시설: 화면 계약이 snake_case 그대로다.
 * `vendor`/`cost`/`notes` 는 **주최자 전용 내부 필드** — 소비자 노출 투영에는 복사되지 않는다.
 */
export function toClientFacility(f: OrganizerFacilityRow) {
  return {
    id: f.id,
    name: f.name,
    category: f.category,
    quantity: f.quantity,
    status: f.status,
    vendor: f.vendor,
    cost: f.cost,
    notes: f.notes,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

/* ══════════════════════════════════════════════════════════════
   Pickket 동적 콘텐츠 섹션 — 공유 타입 + 레지스트리
   packages/lib/src/content-sections.ts
   ══════════════════════════════════════════════════════════════ */

export const SECTION_TYPES = [
  "description",
  "cast",
  "setlist",
  "timetable",
  "notice",
  "seat_guide",
  "transport",
  "related_media",
  "faq",
  "refund_policy",
  "custom",
  "organizer_profile",
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

/* ── 콘텐츠 섹션 데이터 구조 ── */
export interface ContentSection {
  id: string;
  type: SectionType;
  title: string | null;
  visible: boolean;
  sort_order: number;
  content: Record<string, unknown>;
}

/* ── 섹션 타입 메타데이터 ── */
export interface SectionTypeMeta {
  key: SectionType;
  label: string;
  icon: string;
  defaultTitle: string | null;
  maxPerPage: number;
  categories: "all" | string[];
}

/* ── 레지스트리 ── */
export const SECTION_TYPE_REGISTRY: Record<SectionType, SectionTypeMeta> = {
  description: {
    key: "description",
    label: "이벤트 소개",
    icon: "FileText",
    defaultTitle: "이벤트 소개",
    maxPerPage: 1,
    categories: "all",
  },
  cast: {
    key: "cast",
    label: "출연진/캐스트",
    icon: "Users",
    defaultTitle: null,
    maxPerPage: 1,
    categories: ["concert", "musical", "classical", "festival"],
  },
  setlist: {
    key: "setlist",
    label: "세트리스트/프로그램",
    icon: "ListMusic",
    defaultTitle: null,
    maxPerPage: 1,
    categories: ["concert", "musical", "classical"],
  },
  timetable: {
    key: "timetable",
    label: "타임테이블",
    icon: "CalendarClock",
    defaultTitle: "타임테이블",
    maxPerPage: 1,
    categories: ["festival"],
  },
  notice: {
    key: "notice",
    label: "공지사항",
    icon: "Megaphone",
    defaultTitle: "공지사항",
    maxPerPage: 3,
    categories: "all",
  },
  seat_guide: {
    key: "seat_guide",
    label: "좌석 안내",
    icon: "MapPin",
    defaultTitle: "좌석 안내",
    maxPerPage: 1,
    categories: "all",
  },
  transport: {
    key: "transport",
    label: "교통/주차 안내",
    icon: "Car",
    defaultTitle: "교통/주차 안내",
    maxPerPage: 1,
    categories: "all",
  },
  related_media: {
    key: "related_media",
    label: "관련 콘텐츠",
    icon: "PlayCircle",
    defaultTitle: "관련 콘텐츠",
    maxPerPage: 1,
    categories: ["concert", "musical", "classical", "festival"],
  },
  faq: {
    key: "faq",
    label: "자주 묻는 질문",
    icon: "HelpCircle",
    defaultTitle: "자주 묻는 질문",
    maxPerPage: 1,
    categories: "all",
  },
  refund_policy: {
    key: "refund_policy",
    label: "취소/환불 정책",
    icon: "ShieldCheck",
    defaultTitle: "취소/환불 안심 정책",
    maxPerPage: 1,
    categories: "all",
  },
  custom: {
    key: "custom",
    label: "커스텀 섹션",
    icon: "LayoutPanelTop",
    defaultTitle: "섹션",
    maxPerPage: 5,
    categories: "all",
  },
  organizer_profile: {
    key: "organizer_profile",
    label: "주최사 소개",
    icon: "Building2",
    defaultTitle: "주최사 소개",
    maxPerPage: 1,
    categories: "all",
  },
};

/* ── 카테고리별 사용 가능 섹션 필터 ── */
export function getAvailableSections(category: string): SectionTypeMeta[] {
  return Object.values(SECTION_TYPE_REGISTRY).filter(
    (s) => s.categories === "all" || s.categories.includes(category),
  );
}

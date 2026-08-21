export const CATEGORIES = [
  {
    slug: "concert",
    label: "콘서트",
    labelEn: "Concert",
    icon: "Music",
    color: "#FF6B6B",
  },
  {
    slug: "musical",
    label: "뮤지컬/연극",
    labelEn: "Musical",
    icon: "Drama",
    color: "#4ECDC4",
  },
  {
    slug: "sports",
    label: "스포츠",
    labelEn: "Sports",
    icon: "Trophy",
    color: "#45B7D1",
  },
  {
    slug: "classical",
    label: "클래식",
    labelEn: "Classical",
    icon: "Music2",
    color: "#96CEB4",
  },
  {
    slug: "exhibition",
    label: "전시/행사",
    labelEn: "Exhibition",
    icon: "Palette",
    color: "#FFEAA7",
  },
  {
    slug: "festival",
    label: "페스티벌",
    labelEn: "Festival",
    icon: "PartyPopper",
    color: "#DDA0DD",
  },
  {
    slug: "education",
    label: "교육/강연",
    labelEn: "Education",
    icon: "BookOpen",
    color: "#5DADE2",
  },
  {
    slug: "civic",
    label: "시민참여",
    labelEn: "Community",
    icon: "Users",
    color: "#48C9B0",
  },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];

/** slug → 한글 label 매핑 (중복 정의 방지용 정식 소스) */
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.slug, c.label]),
);

/** slug → 영문 label 매핑 */
export const CATEGORY_LABELS_EN: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.slug, c.labelEn]),
);

export const SUB_CATEGORIES: Record<CategorySlug, string[]> = {
  concert: ["K-POP", "록/밴드", "힙합/R&B", "인디", "트로트", "해외아티스트"],
  musical: ["오리지널", "라이선스", "창작", "연극", "오페라"],
  sports: ["야구", "축구", "농구", "배구", "e스포츠", "격투기"],
  classical: ["오케스트라", "독주회", "앙상블", "합창", "오페라"],
  exhibition: ["미술", "사진", "디자인", "체험전", "팝업"],
  festival: ["음악축제", "문화축제", "푸드", "계절행사"],
  education: [
    "시민강좌",
    "인문학특강",
    "직업훈련",
    "워크숍",
    "세미나",
    "자격증",
  ],
  civic: [
    "주민참여예산",
    "공청회",
    "자원봉사",
    "주민설명회",
    "마을회의",
    "시민제안",
  ],
};

export const CITIES = [
  "서울",
  "부산",
  "대구",
  "인천",
  "광주",
  "대전",
  "울산",
  "경기",
  "강원",
  "충청",
  "전라",
  "경상",
  "제주",
] as const;

export const SORT_OPTIONS = [
  { value: "popular", label: "인기순" },
  { value: "newest", label: "최신순" },
  { value: "price_asc", label: "낮은 가격순" },
  { value: "price_desc", label: "높은 가격순" },
  { value: "date", label: "날짜순" },
] as const;

export const DEMAND_LEVELS = {
  HIGH: { label: "경쟁 치열", color: "bg-red-500", textColor: "text-red-500" },
  MEDIUM: {
    label: "인기",
    color: "bg-orange-500",
    textColor: "text-orange-500",
  },
  LOW: { label: "여유", color: "bg-green-500", textColor: "text-green-500" },
  HIDDEN_GEM: {
    label: "숨은 명작",
    color: "bg-purple-600",
    textColor: "text-purple-600",
  },
} as const;

/** sale_mode → {label, color} 매핑 (정식 소스)
 *
 * 레거시 키(lottery, fanclub)와 canonical 키(point_lottery, fanclub_presale) 모두 포함.
 * - 기존 consumer 코드 20+ 파일이 레거시 키에 의존 → 레거시 유지
 * - 신규 코드는 canonical 키 사용 권장
 * - canonical 라벨 정본: contracts/sale-mode.ts CANONICAL_SALE_MODE_LABELS
 */
export const SALE_MODE_LABELS: Record<
  string,
  { label: string; color: string }
> = {
  // 레거시 키 (기존 consumer 코드 호환)
  fixed_fcfs: { label: "잔여 선착순", color: "#00d2a0" },
  lottery: { label: "공정 추첨", color: "#6c5ce7" },
  fanclub: { label: "멤버십 선판매", color: "#4ECDC4" },
  // canonical 키 (신규 코드용, 동일 값)
  point_lottery: { label: "공정 추첨", color: "#6c5ce7" },
  fanclub_presale: { label: "멤버십 선판매", color: "#4ECDC4" },
  queue: { label: "대기열 판매", color: "#fdcb6e" },
};

export const AGE_RESTRICTIONS = [
  "전체",
  "8세 이상",
  "14세 이상",
  "19세 이상",
] as const;

export function getCategoryBySlug(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug);
}

export function getDemandLevel(
  bidCount: number,
  totalSeats: number,
): keyof typeof DEMAND_LEVELS {
  const ratio = totalSeats > 0 ? bidCount / totalSeats : 0;
  if (ratio >= 2) return "HIGH";
  if (ratio >= 1) return "MEDIUM";
  if (ratio < 0.3 && bidCount > 0) return "HIDDEN_GEM";
  return "LOW";
}

export const EFFECTIVE_DATE = "2026년 3월 3일";

/** 정책 버전 (ISO 형식) — 정책 변경 시 이 값을 업데이트 */
export const POLICY_VERSION = "2026-03-03";

/** 이번 버전에서 변경된 정책 목록 */
export const POLICY_CHANGES = ["terms", "privacy", "refund", "youth"] as const;

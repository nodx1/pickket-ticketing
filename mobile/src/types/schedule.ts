/**
 * 일정 피드 타입 정의
 * 텐아시아 파트너십 + 멀티소스 데이터 수집 기반
 */

/** 일정 데이터 소스 */
export type ScheduleSource =
  | "tenasia"
  | "bandsintown"
  | "setlist_fm"
  | "broadcast"
  | "ugc"
  | "pickket";

/** 일정 카테고리 */
export type ScheduleCategory =
  | "concert"
  | "fanmeeting"
  | "broadcast"
  | "festival"
  | "release"
  | "fansign"
  | "other";

/** 일정 아이템 */
export interface ScheduleItem {
  id: string;
  title: string;
  artist_name: string;
  category: ScheduleCategory;
  start_time: string; // ISO 8601
  end_time?: string;
  venue?: string;
  location?: string;
  image_url?: string;
  source: ScheduleSource;
  trust_score: number; // 50-100
  is_bookable: boolean;
  event_id?: string; // Pickket 이벤트 연결 시
  tags?: string[];
}

/** 날짜별 그룹 */
export interface ScheduleDayGroupData {
  date: string; // YYYY-MM-DD
  label: string; // "오늘", "내일", "4월 15일 (화)"
  items: ScheduleItem[];
}

/** 필터 칩 옵션 */
export type ScheduleFilter = "all" | "concert" | "fanmeeting" | "broadcast" | "festival" | "bookable";

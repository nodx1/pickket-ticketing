/**
 * 일정 피드 훅 — React Query 래핑
 * Phase A: 목 데이터 반환, Phase B에서 실제 API 연결
 */
import { useQuery } from "@tanstack/react-query";
import type { ScheduleItem, ScheduleFilter, ScheduleDayGroupData } from "@/types/schedule";

// ── 목 데이터 (Phase B에서 api.ts 연동으로 교체) ──

const NOW = new Date();
const tomorrow = new Date(NOW);
tomorrow.setDate(tomorrow.getDate() + 1);
const dayAfter = new Date(NOW);
dayAfter.setDate(dayAfter.getDate() + 2);

function toISO(date: Date, hour: number, min = 0): string {
  const d = new Date(date);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

const MOCK_SCHEDULE: ScheduleItem[] = [
  {
    id: "s-1",
    title: "IVE THE 1ST WORLD TOUR",
    artist_name: "IVE",
    category: "concert",
    start_time: toISO(NOW, 18, 0),
    venue: "KSPO DOME",
    location: "서울 송파구",
    image_url: "https://picsum.photos/seed/ive-sch/200/200",
    source: "pickket",
    trust_score: 100,
    is_bookable: true,
    event_id: "hm-1",
  },
  {
    id: "s-2",
    title: "아이돌 라디오 시즌4",
    artist_name: "aespa",
    category: "broadcast",
    start_time: toISO(NOW, 20, 0),
    source: "tenasia",
    trust_score: 90,
    is_bookable: false,
  },
  {
    id: "s-3",
    title: "ENHYPEN FATE+ TOUR",
    artist_name: "ENHYPEN",
    category: "concert",
    start_time: toISO(tomorrow, 19, 0),
    venue: "고척스카이돔",
    location: "서울 구로구",
    image_url: "https://picsum.photos/seed/enhy-sch/200/200",
    source: "pickket",
    trust_score: 100,
    is_bookable: true,
    event_id: "hm-3",
  },
  {
    id: "s-4",
    title: "뮤직뱅크 녹화",
    artist_name: "NewJeans, LE SSERAFIM",
    category: "broadcast",
    start_time: toISO(tomorrow, 17, 30),
    venue: "KBS",
    source: "broadcast",
    trust_score: 85,
    is_bookable: false,
  },
  {
    id: "s-5",
    title: "Stray Kids 팬미팅",
    artist_name: "Stray Kids",
    category: "fanmeeting",
    start_time: toISO(dayAfter, 14, 0),
    venue: "잠실실내체육관",
    location: "서울 송파구",
    image_url: "https://picsum.photos/seed/skz-fm/200/200",
    source: "pickket",
    trust_score: 100,
    is_bookable: true,
    event_id: "hm-5",
  },
  {
    id: "s-6",
    title: "서울뮤직페스티벌 2026",
    artist_name: "Various Artists",
    category: "festival",
    start_time: toISO(dayAfter, 12, 0),
    venue: "난지한강공원",
    location: "서울 마포구",
    image_url: "https://picsum.photos/seed/smf-26/200/200",
    source: "pickket",
    trust_score: 100,
    is_bookable: true,
    event_id: "hm-6",
  },
];

async function fetchScheduleFeed(): Promise<ScheduleItem[]> {
  // TODO Phase B: api.get("/schedule/feed") 연동
  // AUDIT 2026-04-20 §20 P0: 백엔드 엔드포인트 미존재 상태에서 프로덕션 노출 금지
  if (!__DEV__) return [];
  return MOCK_SCHEDULE;
}

function formatDateLabel(date: Date): string {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);
  const dateStr = date.toISOString().slice(0, 10);

  if (dateStr === todayStr) return "오늘";
  if (dateStr === tomorrowStr) return "내일";

  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = weekdays[date.getDay()];
  return `${m}월 ${d}일 (${w})`;
}

function groupByDate(items: ScheduleItem[]): ScheduleDayGroupData[] {
  const map = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const key = item.start_time.slice(0, 10);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateStr, dayItems]) => ({
      date: dateStr,
      label: formatDateLabel(new Date(dateStr + "T00:00:00")),
      items: dayItems.sort(
        (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
      ),
    }));
}

function filterItems(items: ScheduleItem[], filter: ScheduleFilter): ScheduleItem[] {
  if (filter === "all") return items;
  if (filter === "bookable") return items.filter((i) => i.is_bookable);
  return items.filter((i) => i.category === filter);
}

/** 전체 일정 피드 */
export function useScheduleFeed(filter: ScheduleFilter = "all") {
  return useQuery({
    queryKey: ["schedule", "feed", filter],
    queryFn: async () => {
      const all = await fetchScheduleFeed();
      const filtered = filterItems(all, filter);
      return groupByDate(filtered);
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** 오늘 일정만 (홈 섹션용) */
export function useTodaySchedule() {
  return useQuery({
    queryKey: ["schedule", "today"],
    queryFn: async () => {
      const all = await fetchScheduleFeed();
      const todayStr = new Date().toISOString().slice(0, 10);
      return all
        .filter((item) => item.start_time.startsWith(todayStr))
        .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    },
    staleTime: 5 * 60 * 1000,
  });
}

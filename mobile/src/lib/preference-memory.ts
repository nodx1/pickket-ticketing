/**
 * preference-memory — 사용자 취향 로컬 메모리 (Phase B.3)
 *
 * 목적: 사용자의 공연 관람/즐겨찾기/검색 이력을 로컬에 누적 → AI 검색 호출 시
 * user_context로 함께 전송하여 LLM이 개인화된 추천을 생성.
 *
 * 저장 위치: AsyncStorage (민감하지 않은 취향 데이터)
 * 저장 구조: PreferenceData (genre counts + price ranges + time patterns + keywords)
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@pickket/preference-memory:v1";
const MAX_KEYWORDS = 50;

export interface PreferenceData {
  /** 카테고리별 접촉 횟수 (CONCERT, MUSICAL, ...) */
  categories: Record<string, number>;
  /** 검색/즐겨찾기 키워드 (최근순, 최대 50개) */
  keywords: string[];
  /** 최근 관람 가격대 (min/max/median) */
  price_samples: number[];
  /** 주말/평일/저녁 등 시간 패턴 카운트 */
  time_patterns: Record<string, number>;
  /** 마지막 갱신 시각 (ISO) */
  updated_at: string;
}

function emptyPreferences(): PreferenceData {
  return {
    categories: {},
    keywords: [],
    price_samples: [],
    time_patterns: {},
    updated_at: new Date(0).toISOString(),
  };
}

export async function getPreferences(): Promise<PreferenceData> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyPreferences();
    const parsed = JSON.parse(raw) as Partial<PreferenceData>;
    return {
      categories: { ...(parsed.categories ?? {}) },
      keywords: [...(parsed.keywords ?? [])],
      price_samples: [...(parsed.price_samples ?? [])],
      time_patterns: { ...(parsed.time_patterns ?? {}) },
      updated_at: parsed.updated_at ?? new Date(0).toISOString(),
    };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    return emptyPreferences();
  }
}

async function savePreferences(data: PreferenceData): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    // non-fatal
  }
}

export async function recordCategoryView(category: string): Promise<void> {
  const data = await getPreferences();
  data.categories[category] = (data.categories[category] ?? 0) + 1;
  data.updated_at = new Date().toISOString();
  await savePreferences(data);
}

export async function recordKeyword(keyword: string): Promise<void> {
  const k = keyword.trim();
  if (!k) return;
  const data = await getPreferences();
  // 중복 제거 후 최신 키워드를 앞에 배치
  const filtered = data.keywords.filter((w) => w !== k);
  data.keywords = [k, ...filtered].slice(0, MAX_KEYWORDS);
  data.updated_at = new Date().toISOString();
  await savePreferences(data);
}

export async function recordPriceSample(price: number): Promise<void> {
  if (!Number.isFinite(price) || price < 0) return;
  const data = await getPreferences();
  data.price_samples = [price, ...data.price_samples].slice(0, 50);
  data.updated_at = new Date().toISOString();
  await savePreferences(data);
}

export async function recordTimePattern(eventDate: string): Promise<void> {
  try {
    const d = new Date(eventDate);
    if (Number.isNaN(d.getTime())) return;
    const day = d.getDay(); // 0=일, 6=토
    const hour = d.getHours();
    const key =
      day === 0 || day === 6
        ? hour >= 18
          ? "weekend_evening"
          : "weekend_day"
        : hour >= 18
        ? "weekday_evening"
        : "weekday_day";
    const data = await getPreferences();
    data.time_patterns[key] = (data.time_patterns[key] ?? 0) + 1;
    data.updated_at = new Date().toISOString();
    await savePreferences(data);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    // ignore
  }
}

export async function clearPreferences(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    // ignore
  }
}

/**
 * /discover API에 실어 보낼 요약 컨텍스트.
 * 백엔드가 user_context 필드로 받아 LLM 프롬프트에 주입.
 */
export interface PreferenceContext {
  favorite_categories: string[];
  recent_keywords: string[];
  typical_price_range: [number, number] | null;
  typical_time: string | null;
}

export function summarizeContext(data: PreferenceData): PreferenceContext {
  const favorite_categories = Object.entries(data.categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k]) => k);

  const recent_keywords = data.keywords.slice(0, 10);

  let typical_price_range: [number, number] | null = null;
  if (data.price_samples.length > 0) {
    const sorted = [...data.price_samples].sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    typical_price_range = [p25, p75];
  }

  let typical_time: string | null = null;
  const timeEntries = Object.entries(data.time_patterns);
  if (timeEntries.length > 0) {
    typical_time = timeEntries.sort(([, a], [, b]) => b - a)[0][0];
  }

  return { favorite_categories, recent_keywords, typical_price_range, typical_time };
}

export async function getPreferenceContext(): Promise<PreferenceContext> {
  const data = await getPreferences();
  return summarizeContext(data);
}

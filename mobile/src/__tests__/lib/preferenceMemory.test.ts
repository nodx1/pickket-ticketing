/**
 * preference-memory 단위 테스트 (Phase B.3)
 *
 * AsyncStorage를 in-memory mock으로 대체, 기록 누적·요약 로직 검증
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

// in-memory 저장소 — 전역 setup mock을 덮어쓰기
const store: Record<string, string> = {};

function installMocks() {
  (AsyncStorage.getItem as jest.Mock).mockImplementation((k: string) =>
    Promise.resolve(Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  );
  (AsyncStorage.setItem as jest.Mock).mockImplementation((k: string, v: string) => {
    store[k] = v;
    return Promise.resolve();
  });
  (AsyncStorage.removeItem as jest.Mock).mockImplementation((k: string) => {
    delete store[k];
    return Promise.resolve();
  });
}

installMocks();
import {
  getPreferences,
  getPreferenceContext,
  recordCategoryView,
  recordKeyword,
  recordPriceSample,
  recordTimePattern,
  clearPreferences,
  summarizeContext,
  type PreferenceData,
} from "@/lib/preference-memory";

beforeEach(async () => {
  installMocks();
  for (const k of Object.keys(store)) delete store[k];
});

describe("preference-memory", () => {
  it("초기 상태는 빈 객체 반환", async () => {
    const data = await getPreferences();
    expect(data.categories).toEqual({});
    expect(data.keywords).toEqual([]);
    expect(data.price_samples).toEqual([]);
  });

  it("recordCategoryView는 카운트 누적", async () => {
    await recordCategoryView("CONCERT");
    await recordCategoryView("CONCERT");
    await recordCategoryView("MUSICAL");
    const data = await getPreferences();
    expect(data.categories.CONCERT).toBe(2);
    expect(data.categories.MUSICAL).toBe(1);
  });

  it("recordKeyword는 중복 제거 + 최신순", async () => {
    await recordKeyword("재즈");
    await recordKeyword("뮤지컬");
    await recordKeyword("재즈"); // 중복
    const data = await getPreferences();
    expect(data.keywords).toEqual(["재즈", "뮤지컬"]);
  });

  it("recordPriceSample은 숫자만 누적, 잘못된 값 무시", async () => {
    await recordPriceSample(50000);
    await recordPriceSample(-1); // 무시
    await recordPriceSample(NaN); // 무시
    await recordPriceSample(80000);
    const data = await getPreferences();
    expect(data.price_samples).toEqual([80000, 50000]);
  });

  it("recordTimePattern은 요일/시간 분류", async () => {
    // 2026-04-11은 토요일
    await recordTimePattern("2026-04-11T19:00:00");
    await recordTimePattern("2026-04-13T14:00:00"); // 월요일 오후
    const data = await getPreferences();
    expect(data.time_patterns.weekend_evening).toBe(1);
    expect(data.time_patterns.weekday_day).toBe(1);
  });

  it("summarizeContext는 상위 3개 카테고리 + 가격 분위수 + 주 시간대", () => {
    const data: PreferenceData = {
      categories: { CONCERT: 10, MUSICAL: 5, SPORTS: 1, FESTIVAL: 3 },
      keywords: ["재즈", "록", "클래식"],
      price_samples: [10000, 30000, 50000, 70000, 90000],
      time_patterns: { weekend_evening: 8, weekday_evening: 3 },
      updated_at: new Date().toISOString(),
    };
    const ctx = summarizeContext(data);
    expect(ctx.favorite_categories).toEqual(["CONCERT", "MUSICAL", "FESTIVAL"]);
    expect(ctx.recent_keywords).toEqual(["재즈", "록", "클래식"]);
    expect(ctx.typical_price_range).not.toBeNull();
    expect(ctx.typical_time).toBe("weekend_evening");
  });

  it("getPreferenceContext는 빈 상태에서도 정상 반환", async () => {
    const ctx = await getPreferenceContext();
    expect(ctx.favorite_categories).toEqual([]);
    expect(ctx.typical_price_range).toBeNull();
    expect(ctx.typical_time).toBeNull();
  });

  it("clearPreferences는 저장소 초기화", async () => {
    await recordCategoryView("CONCERT");
    await clearPreferences();
    const data = await getPreferences();
    expect(data.categories).toEqual({});
  });
});

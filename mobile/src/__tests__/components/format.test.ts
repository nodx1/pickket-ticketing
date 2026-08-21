/**
 * format 유틸리티 단위 테스트
 */
jest.mock("@/i18n", () => {
  const i18n = {
    t: (key: string) => key === "event.free" ? "무료" : key,
    language: "ko",
  };
  return { __esModule: true, default: i18n };
});

const { formatKRW, formatPriceRange, formatEventDate, formatShortDate, getCategoryFallbackColor, getCategoryEmoji } =
  require("@/lib/format") as typeof import("@/lib/format");

describe("formatKRW", () => {
  it("기본 포맷", () => {
    expect(formatKRW(50000)).toBe("₩50,000");
  });

  it("0원", () => {
    expect(formatKRW(0)).toBe("₩0");
  });

  it("큰 금액", () => {
    expect(formatKRW(1500000)).toBe("₩1,500,000");
  });
});

describe("formatPriceRange", () => {
  it("min/max 다른 경우 범위 표시", () => {
    const result = formatPriceRange(50000, 150000);
    expect(result).toBe("₩50,000 ~ ₩150,000");
  });

  it("min/max 같으면 단일 가격", () => {
    expect(formatPriceRange(50000, 50000)).toBe("₩50,000");
  });

  it("0/0이면 무료", () => {
    expect(formatPriceRange(0, 0)).toBe("무료");
  });

  it("null이면 빈 문자열", () => {
    expect(formatPriceRange(null, null)).toBe("");
  });

  it("min만 있으면 단일 가격", () => {
    expect(formatPriceRange(33000, null)).toBe("₩33,000");
  });
});

describe("formatEventDate", () => {
  it("날짜 포맷 — 월/일/요일/시간 포함", () => {
    const result = formatEventDate("2026-09-29T19:55:00Z");
    // TZ에 따라 시간이 달라질 수 있으므로 형식만 확인
    expect(result).toMatch(/.+ \d+ \(.+\) \d{2}:\d{2}/);
  });
});

describe("formatShortDate", () => {
  it("짧은 날짜 포맷 — 월.일 (요일)", () => {
    const result = formatShortDate("2026-09-29T19:55:00Z");
    // TZ에 따라 날짜가 29 or 30일 수 있음
    expect(result).toMatch(/\d+\.\d+ \(.+\)/);
  });
});

describe("getCategoryFallbackColor", () => {
  it("CONCERT → 보라색", () => {
    expect(getCategoryFallbackColor("CONCERT")).toBe("#6366f1");
  });

  it("알 수 없는 카테고리 → 기본색", () => {
    expect(getCategoryFallbackColor("UNKNOWN")).toBe("#4A5BC4");
  });

  it("null → 기본색", () => {
    expect(getCategoryFallbackColor(null)).toBe("#4A5BC4");
  });
});

describe("getCategoryEmoji", () => {
  it("CONCERT → 🎵", () => {
    expect(getCategoryEmoji("CONCERT")).toBe("🎵");
  });

  it("SPORTS → ⚽", () => {
    expect(getCategoryEmoji("SPORTS")).toBe("⚽");
  });

  it("null → 기본 이모지", () => {
    expect(getCategoryEmoji(null)).toBe("🎫");
  });
});

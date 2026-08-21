import { describe, it, expect } from "vitest";
import {
  formatKRW,
  formatDate,
  formatDateShort,
  formatShortDate,
  getStatusLabel,
  getStatusColor,
  getBidStatusLabel,
  getBidStatusColor,
  getSaleModeLabel,
  getSaleModeDescription,
  getSeatingTypeLabel,
  formatSeatLabel,
  formatCurrency,
  formatEventTime,
  resolveIntlLocale,
  localeToCurrency,
  maskEmail,
} from "../format";

describe("resolveIntlLocale", () => {
  it("maps short locale codes to full Intl locales", () => {
    expect(resolveIntlLocale("ko")).toBe("ko-KR");
    expect(resolveIntlLocale("en")).toBe("en-US");
    expect(resolveIntlLocale("ja")).toBe("ja-JP");
  });

  it("defaults to ko-KR when omitted", () => {
    expect(resolveIntlLocale()).toBe("ko-KR");
    expect(resolveIntlLocale(undefined)).toBe("ko-KR");
  });

  it("passes through full locale strings", () => {
    expect(resolveIntlLocale("fr-FR")).toBe("fr-FR");
  });
});

describe("localeToCurrency", () => {
  it("maps app locales to default currencies", () => {
    expect(localeToCurrency("ko")).toBe("KRW");
    expect(localeToCurrency("ja")).toBe("JPY");
    expect(localeToCurrency("en")).toBe("USD");
  });

  it("defaults to KRW when omitted", () => {
    expect(localeToCurrency()).toBe("KRW");
  });
});

describe("formatKRW", () => {
  it("formats zero", () => {
    expect(formatKRW(0)).toBe("\u20A90");
  });

  it("formats positive amounts with commas", () => {
    expect(formatKRW(50000)).toBe("\u20A950,000");
  });

  it("formats large amounts", () => {
    expect(formatKRW(1000000)).toBe("\u20A91,000,000");
  });

  it("truncates decimals", () => {
    const result = formatKRW(1234.56);
    expect(result).not.toContain(".");
  });
});

describe("formatDate", () => {
  it("includes year in output", () => {
    const result = formatDate("2026-03-15T14:30:00Z");
    expect(result).toContain("2026");
  });

  it("accepts locale parameter", () => {
    const result = formatDate("2026-03-15T14:30:00Z", "en");
    expect(result).toContain("2026");
  });
});

describe("formatDateShort", () => {
  it("returns short date format", () => {
    const result = formatDateShort("2026-06-15T00:00:00Z");
    expect(result).toContain("15");
  });
});

describe("formatShortDate", () => {
  it('returns "-" for null input', () => {
    expect(formatShortDate(null)).toBe("-");
  });

  it('returns "-" for undefined input', () => {
    expect(formatShortDate(undefined)).toBe("-");
  });

  it("returns formatted date for valid input", () => {
    const result = formatShortDate("2026-06-15T14:30:00Z");
    expect(result).toContain("15");
  });
});

describe("getStatusLabel", () => {
  it("returns Korean labels for all known statuses", () => {
    expect(getStatusLabel("draft")).toBe("준비중");
    expect(getStatusLabel("bidding_open")).toBe("응모중");
    expect(getStatusLabel("bidding_closed")).toBe("응모마감");
    expect(getStatusLabel("allocating")).toBe("배분중");
    expect(getStatusLabel("allocated")).toBe("배분완료");
    expect(getStatusLabel("completed")).toBe("종료");
    expect(getStatusLabel("cancelled")).toBe("취소");
  });

  it("returns raw status for unknown values", () => {
    expect(getStatusLabel("unknown_status")).toBe("unknown_status");
  });
});

describe("getStatusColor", () => {
  it("returns green classes for bidding_open", () => {
    expect(getStatusColor("bidding_open")).toContain("green");
  });

  it("returns red classes for cancelled", () => {
    expect(getStatusColor("cancelled")).toContain("red");
  });

  it("returns gray classes for unknown status", () => {
    expect(getStatusColor("xyz")).toContain("gray");
  });

  it("returns blue classes for allocating", () => {
    expect(getStatusColor("allocating")).toContain("blue");
  });

  it("returns purple classes for allocated", () => {
    expect(getStatusColor("allocated")).toContain("purple");
  });
});

describe("getBidStatusLabel", () => {
  it("returns Korean labels for all bid statuses", () => {
    expect(getBidStatusLabel("active")).toBe("응모중");
    expect(getBidStatusLabel("won")).toBe("당첨");
    expect(getBidStatusLabel("lost")).toBe("미당첨");
    expect(getBidStatusLabel("cancelled")).toBe("취소");
    expect(getBidStatusLabel("rejected")).toBe("차단");
  });

  it("returns raw status for unknown", () => {
    expect(getBidStatusLabel("pending")).toBe("추첨 대기");
  });
});

describe("getBidStatusColor", () => {
  it("returns green for won", () => {
    expect(getBidStatusColor("won")).toContain("green");
  });

  it("returns red for rejected", () => {
    expect(getBidStatusColor("rejected")).toContain("red");
  });

  it("returns orange for lost", () => {
    expect(getBidStatusColor("lost")).toContain("orange");
  });

  it("returns blue for active", () => {
    expect(getBidStatusColor("active")).toContain("blue");
  });

  it("returns gray default for unknown", () => {
    expect(getBidStatusColor("unknown")).toContain("gray");
  });
});

describe("getSaleModeLabel", () => {
  it("returns Korean labels for all sale modes", () => {
    expect(getSaleModeLabel("fixed_fcfs")).toBe("선착순");
    expect(getSaleModeLabel("lottery")).toBe("공정 배분");
    expect(getSaleModeLabel("fanclub")).toBe("멤버십 선판매");
  });

  it("returns raw mode for unknown", () => {
    expect(getSaleModeLabel("custom")).toBe("custom");
  });
});

describe("getSaleModeDescription", () => {
  it("returns descriptions for known modes", () => {
    expect(getSaleModeDescription("fixed_fcfs")).toContain("선착순");
    expect(getSaleModeDescription("lottery")).toContain("공정");
    expect(getSaleModeDescription("fanclub")).toContain("멤버십");
  });

  it("returns empty string for unknown mode", () => {
    expect(getSaleModeDescription("unknown")).toBe("");
  });
});

describe("getSeatingTypeLabel", () => {
  it("returns Korean labels for seating types", () => {
    expect(getSeatingTypeLabel("assigned")).toBe("지정석");
    expect(getSeatingTypeLabel("general_admission")).toBe("자유석");
    expect(getSeatingTypeLabel("standing")).toBe("스탠딩");
  });

  it("returns raw type for unknown", () => {
    expect(getSeatingTypeLabel("vip_box")).toBe("vip_box");
  });
});

describe("formatSeatLabel", () => {
  it("formats seat label correctly", () => {
    expect(formatSeatLabel("A", 3, 15)).toBe("A구역 3열 15번");
  });

  it("handles single digit values", () => {
    expect(formatSeatLabel("B", 1, 1)).toBe("B구역 1열 1번");
  });
});

describe("formatCurrency", () => {
  it("formats KRW without decimals", () => {
    const result = formatCurrency(50000, "KRW");
    expect(result).toContain("50,000");
  });

  it("formats USD with locale", () => {
    const result = formatCurrency(99.99, "USD");
    expect(result).toContain("$");
  });

  it("formats JPY without decimals", () => {
    const result = formatCurrency(5000, "JPY");
    expect(result).not.toContain(".");
  });

  it("defaults to KRW when no currency specified", () => {
    const result = formatCurrency(10000);
    expect(result).toContain("10,000");
  });

  it("uses custom locale when provided", () => {
    const result = formatCurrency(1000, "USD", "en-US");
    expect(result).toContain("$");
  });

  it("resolves short app locale for currency formatting", () => {
    const result = formatCurrency(1000, "USD", "en");
    expect(result).toContain("$");
  });
});

describe("maskEmail", () => {
  it("masks a typical email to first char + ***", () => {
    expect(maskEmail("user@pickket.kr")).toBe("u***@pickket.kr");
  });

  it("matches backend pii.mask_email pattern (user@domain.com → u***@domain.com)", () => {
    expect(maskEmail("user@domain.com")).toBe("u***@domain.com");
  });

  it("keeps 1-char local-part intact (insufficient entropy to mask)", () => {
    expect(maskEmail("a@pickket.kr")).toBe("a@pickket.kr");
  });

  it("returns empty string for null/undefined/empty input", () => {
    expect(maskEmail(null)).toBe("");
    expect(maskEmail(undefined)).toBe("");
    expect(maskEmail("")).toBe("");
  });

  it("returns value unchanged when no @ is present", () => {
    expect(maskEmail("not-an-email")).toBe("not-an-email");
  });
});

describe("formatEventTime", () => {
  it("returns eventLocal for same timezone", () => {
    const result = formatEventTime("2026-06-15T14:30:00Z", "Asia/Seoul");
    expect(result.eventLocal).toBeDefined();
    expect(result.viewerLocal).toBeUndefined();
  });

  it("returns both times when viewer timezone differs", () => {
    const result = formatEventTime(
      "2026-06-15T14:30:00Z",
      "Asia/Seoul",
      "America/New_York",
    );
    expect(result.eventLocal).toBeDefined();
    expect(result.viewerLocal).toBeDefined();
  });

  it("omits viewerLocal when viewerTimezone matches eventTimezone", () => {
    const result = formatEventTime(
      "2026-06-15T14:30:00Z",
      "Asia/Seoul",
      "Asia/Seoul",
    );
    expect(result.viewerLocal).toBeUndefined();
  });

  it("defaults to Asia/Seoul timezone", () => {
    const result = formatEventTime("2026-06-15T14:30:00Z");
    expect(result.eventLocal).toBeDefined();
  });

  it("accepts Date object as input", () => {
    const date = new Date("2026-06-15T14:30:00Z");
    const result = formatEventTime(date);
    expect(result.eventLocal).toBeDefined();
  });
});

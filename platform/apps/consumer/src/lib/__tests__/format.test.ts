import { describe, it, expect } from "vitest";
import {
  formatKRW,
  formatDate,
  formatDateShort,
  getStatusLabel,
  getStatusColor,
  getBidStatusLabel,
  getBidStatusColor,
  getSaleModeLabel,
  getSaleModeDescription,
  getSeatingTypeLabel,
  formatSeatLabel,
} from "@pickket/lib/format";

describe("formatKRW", () => {
  it("formats zero", () => {
    expect(formatKRW(0)).toBe("₩0");
  });

  it("formats positive amounts with commas", () => {
    expect(formatKRW(50000)).toBe("₩50,000");
  });

  it("formats large amounts", () => {
    expect(formatKRW(1000000)).toBe("₩1,000,000");
  });

  it("truncates decimals", () => {
    const result = formatKRW(1234.56);
    expect(result).not.toContain(".");
  });
});

describe("formatDate", () => {
  it("formats ISO date string to Korean locale", () => {
    const result = formatDate("2026-03-15T14:30:00Z");
    expect(result).toContain("2026");
    expect(result).toContain("15");
  });
});

describe("formatDateShort", () => {
  it("returns short date format", () => {
    const result = formatDateShort("2026-06-15T00:00:00Z");
    expect(result).toContain("15");
  });
});

describe("getStatusLabel", () => {
  it("returns Korean labels for known statuses", () => {
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
  it("returns CSS classes for known statuses", () => {
    expect(getStatusColor("bidding_open")).toContain("green");
    expect(getStatusColor("cancelled")).toContain("red");
  });

  it("returns default for unknown status", () => {
    expect(getStatusColor("xyz")).toContain("gray");
  });
});

describe("getBidStatusLabel", () => {
  it("returns Korean labels for bid statuses", () => {
    expect(getBidStatusLabel("active")).toBe("응모중");
    expect(getBidStatusLabel("won")).toBe("당첨");
    expect(getBidStatusLabel("lost")).toBe("미당첨");
    expect(getBidStatusLabel("cancelled")).toBe("취소");
    expect(getBidStatusLabel("rejected")).toBe("차단");
  });
});

describe("getBidStatusColor", () => {
  it("returns CSS classes for bid statuses", () => {
    expect(getBidStatusColor("won")).toContain("green");
    expect(getBidStatusColor("rejected")).toContain("red");
  });
});

describe("getSaleModeLabel", () => {
  it("returns Korean labels for sale modes", () => {
    expect(getSaleModeLabel("fixed_fcfs")).toBe("선착순");
    expect(getSaleModeLabel("lottery")).toBe("공정 배분");
    expect(getSaleModeLabel("fanclub")).toBe("멤버십 선판매");
  });

  it("returns raw mode for unknown values", () => {
    expect(getSaleModeLabel("custom")).toBe("custom");
  });
});

describe("getSaleModeDescription", () => {
  it("returns descriptions for sale modes", () => {
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
});

describe("formatSeatLabel", () => {
  it("formats seat label correctly", () => {
    expect(formatSeatLabel("A", 3, 15)).toBe("A구역 3열 15번");
  });
});

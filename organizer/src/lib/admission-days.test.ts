import { describe, it, expect } from "vitest";
import { listAdmissionDays, toKstDay } from "./admission-days";

describe("toKstDay", () => {
  it("ISO 시각을 KST 날짜로 변환한다", () => {
    // 2026-10-02T20:00Z = KST 2026-10-03 05:00
    expect(toKstDay("2026-10-02T20:00:00Z")).toBe("2026-10-03");
  });
  it("무효값은 null", () => {
    expect(toKstDay("")).toBeNull();
    expect(toKstDay("not-a-date")).toBeNull();
  });
});

describe("listAdmissionDays", () => {
  it("기간 내 하루 단위 옵션을 열거한다(포함 경계)", () => {
    const days = listAdmissionDays("2026-10-03T10:00:00+09:00", "2026-10-05T22:00:00+09:00");
    expect(days.map((d) => d.value)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
  });
  it("단일일(같은 날)이면 1개", () => {
    const days = listAdmissionDays("2026-10-03T10:00:00+09:00", "2026-10-03T22:00:00+09:00");
    expect(days).toHaveLength(1);
    expect(days[0].value).toBe("2026-10-03");
  });
  it("종료 미지정이면 시작일 기준 1개", () => {
    const days = listAdmissionDays("2026-10-03T10:00:00+09:00", null);
    expect(days).toHaveLength(1);
  });
  it("라벨은 한국어 월/일/요일 표기", () => {
    const days = listAdmissionDays("2026-10-03T10:00:00+09:00", "2026-10-03T22:00:00+09:00");
    // 2026-10-03 은 토요일
    expect(days[0].label).toContain("10월 3일");
    expect(days[0].label).toContain("토");
  });
});

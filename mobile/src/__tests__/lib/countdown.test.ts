/**
 * countdown 단위 테스트 (Phase D.1)
 */
import { computeCountdown } from "@/lib/countdown";

const iso = (d: Date) => d.toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("computeCountdown", () => {
  const base = Date.UTC(2026, 3, 8, 9, 0, 0); // 2026-04-08T09:00:00Z

  it("eventDate 없음 → past", () => {
    const info = computeCountdown(undefined, base);
    expect(info.stage).toBe("past");
  });

  it("잘못된 ISO → past", () => {
    const info = computeCountdown("not-a-date", base);
    expect(info.stage).toBe("past");
  });

  it("10일 뒤 → far", () => {
    const info = computeCountdown(iso(new Date(base + 10 * DAY)), base);
    expect(info.stage).toBe("far");
    expect(info.daysRemaining).toBe(10);
  });

  it("6일 뒤 → week", () => {
    const info = computeCountdown(iso(new Date(base + 6 * DAY)), base);
    expect(info.stage).toBe("week");
    expect(info.daysRemaining).toBe(6);
  });

  it("2일 뒤 → approaching", () => {
    const info = computeCountdown(iso(new Date(base + 2 * DAY)), base);
    expect(info.stage).toBe("approaching");
    expect(info.daysRemaining).toBe(2);
  });

  it("1일 뒤 → tomorrow", () => {
    const info = computeCountdown(iso(new Date(base + DAY + HOUR)), base);
    expect(info.stage).toBe("tomorrow");
    expect(info.daysRemaining).toBe(1);
  });

  it("당일 (몇 시간 전) → today", () => {
    const info = computeCountdown(iso(new Date(base + 3 * HOUR)), base);
    expect(info.stage).toBe("today");
    expect(info.daysRemaining).toBe(0);
    expect(info.hoursRemaining).toBe(3);
  });

  it("시작 직후 2시간 → live", () => {
    const info = computeCountdown(iso(new Date(base - 2 * HOUR)), base);
    expect(info.stage).toBe("live");
    expect(info.msRemaining).toBeLessThan(0);
  });

  it("2일 전 → past", () => {
    const info = computeCountdown(iso(new Date(base - 2 * DAY)), base);
    expect(info.stage).toBe("past");
  });
});

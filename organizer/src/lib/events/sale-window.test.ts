import { describe, expect, it } from "vitest";

import { resolveInitialSaleWindow } from "./sale-window";

const NOW = "2026-07-28T05:00:00.000Z";

function opensBeforeCloses(w: { opens_at: string; closes_at: string }) {
  return new Date(w.closes_at).getTime() > new Date(w.opens_at).getTime();
}

describe("resolveInitialSaleWindow", () => {
  it("시작이 미래면 시작 시각에 판매를 닫는다 — 기존 동작", () => {
    const w = resolveInitialSaleWindow("2026-08-05T00:00:00.000Z", "2026-08-05T12:00:00.000Z", NOW);
    expect(w).toEqual({ opens_at: NOW, closes_at: "2026-08-05T00:00:00.000Z" });
  });

  it("🔴 시작이 지났고 종료가 남았으면 종료까지 판다 — 진행 중 행사 등록", () => {
    // 종전에는 closes_at 이 과거가 되어 v2 가 400, 화면엔 "잠시 후 재시도" 가 떴다.
    const w = resolveInitialSaleWindow("2026-07-28T01:00:00.000Z", "2026-07-28T23:00:00.000Z", NOW);
    expect(w.closes_at).toBe("2026-07-28T23:00:00.000Z");
    expect(opensBeforeCloses(w)).toBe(true);
  });

  it("🔴 지난 행사는 판매창이 **이미 닫혀** 있다 — 열린 창을 만들면 안 된다", () => {
    // 회신 #19 지적: v2 주문 게이트는 status·sale_window·sales_paused 만 보고
    // event_date 가 지났는지는 보지 않는다. `지금~지금+1h` 를 주면 기록용으로 등록한
    // 지난 행사가 1시간 동안 실제로 팔린다.
    const w = resolveInitialSaleWindow("2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z", NOW);
    expect(opensBeforeCloses(w)).toBe(true);
    expect(new Date(w.closes_at).getTime()).toBeLessThan(new Date(NOW).getTime());
  });

  it("🔴 종료 일시가 없는 지난 행사도 닫힌 창이어야 한다", () => {
    const w = resolveInitialSaleWindow("2026-07-01T00:00:00.000Z", null, NOW);
    expect(opensBeforeCloses(w)).toBe(true);
    expect(new Date(w.closes_at).getTime()).toBeLessThan(new Date(NOW).getTime());
  });

  it("진행 중인 행사는 지금이 창 안이라 계속 팔린다", () => {
    const w = resolveInitialSaleWindow("2026-07-28T01:00:00.000Z", "2026-07-28T23:00:00.000Z", NOW);
    const now = new Date(NOW).getTime();
    expect(new Date(w.opens_at).getTime()).toBeLessThanOrEqual(now);
    expect(new Date(w.closes_at).getTime()).toBeGreaterThan(now);
  });

  it("시작 == 지금(경계)이면 미래로 보지 않는다 — closes_at <= opens_at 이 되면 v2 가 거절한다", () => {
    const w = resolveInitialSaleWindow(NOW, "2026-07-28T23:00:00.000Z", NOW);
    expect(opensBeforeCloses(w)).toBe(true);
    expect(w.closes_at).toBe("2026-07-28T23:00:00.000Z");
  });

  it("깨진 날짜 문자열에도 유효한 창을 낸다 — 개설이 통째로 막히면 안 된다", () => {
    const w = resolveInitialSaleWindow("not-a-date", "also-bad", NOW);
    expect(opensBeforeCloses(w)).toBe(true);
  });

  it.each([
    ["2026-08-05T00:00:00.000Z", "2026-08-05T12:00:00.000Z"],
    ["2026-07-28T01:00:00.000Z", "2026-07-28T23:00:00.000Z"],
    ["2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z"],
    ["2026-07-28T05:00:00.000Z", null],
  ] as Array<[string, string | null]>)(
    "어떤 입력이든 closes_at > opens_at 을 지킨다 (%s)",
    (starts, ends) => {
      expect(opensBeforeCloses(resolveInitialSaleWindow(starts, ends, NOW))).toBe(true);
    },
  );
});

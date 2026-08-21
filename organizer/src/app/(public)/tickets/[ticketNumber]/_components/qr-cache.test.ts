import { describe, expect, it } from "vitest";

import { LOW_WATERMARK, pruneAndCountUsable, shouldRefill, windowOf } from "./qr-cache";

/**
 * 🔴 실결함 재현: 지난 창을 안 지우면 캐시가 **항상 가득 차 보여** 미리 채우기가
 * 영영 발동하지 않는다. 그러면 캐시가 바닥난 순간에야 서버를 부르고, 그때 네트워크가
 * 끊겨 있으면 QR 이 죽는다 — 골프장 대비 장치가 무력화된다.
 * 화면상으로는 "30초마다 QR 이 바뀐다" 로 똑같이 보여 눈으로는 구분되지 않는다.
 */
function cacheOf(windows: number[]): Map<number, string> {
  return new Map(windows.map((w) => [w, `PKT:T:${w}:x`]));
}

describe("pruneAndCountUsable", () => {
  it("🔴 지난 창을 버리고 **앞으로 쓸 창만** 센다", () => {
    const c = cacheOf([10, 11, 12, 13, 14]);
    expect(pruneAndCountUsable(c, 13)).toBe(2); // 13,14 만 유효
    expect([...c.keys()]).toEqual([13, 14]);
  });

  it("현재 창은 유효하다(지금 그려야 하는 창)", () => {
    const c = cacheOf([10]);
    expect(pruneAndCountUsable(c, 10)).toBe(1);
  });

  it("전부 지난 창이면 0 — 즉시 다시 받아야 한다", () => {
    const c = cacheOf([1, 2, 3]);
    expect(pruneAndCountUsable(c, 100)).toBe(0);
    expect(c.size).toBe(0);
  });

  it("빈 캐시는 0", () => {
    expect(pruneAndCountUsable(new Map(), 5)).toBe(0);
  });
});

describe("shouldRefill", () => {
  it("🔴 남은 창이 임계 이하면 **미리** 받는다 — 끊기고 나서 받으면 늦다", () => {
    expect(shouldRefill(LOW_WATERMARK)).toBe(true);
    expect(shouldRefill(0)).toBe(true);
  });

  it("넉넉하면 서버를 부르지 않는다(30초마다 호출하던 것을 줄인 이유)", () => {
    expect(shouldRefill(LOW_WATERMARK + 1)).toBe(false);
    expect(shouldRefill(20)).toBe(false);
  });

  it("🔴 20창을 받은 직후에 곧바로 또 받지 않는다", () => {
    // 여기가 참이 되면 매 tick 서버를 불러 선발급의 의미가 사라진다.
    const c = cacheOf(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(shouldRefill(pruneAndCountUsable(c, 100))).toBe(false);
  });

  it("🔴 15창이 지나 5창 남으면 그때 받는다(바닥나기 전)", () => {
    const c = cacheOf(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(shouldRefill(pruneAndCountUsable(c, 115))).toBe(true);
  });
});

describe("windowOf", () => {
  it("30초 단위로 창이 바뀐다", () => {
    expect(windowOf(0)).toBe(0);
    expect(windowOf(29_999)).toBe(0);
    expect(windowOf(30_000)).toBe(1);
  });
});

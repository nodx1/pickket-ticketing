import { describe, it, expect } from "vitest";

import { numCoord, seatCoordFields } from "./seat-coord";

describe("numCoord — NUMERIC(8,3)/(4,3) → Float 무손실 정규화", () => {
  it("숫자는 그대로", () => {
    expect(numCoord(12.5)).toBe(12.5);
    expect(numCoord(0)).toBe(0);
  });

  it("pg NUMERIC 문자열을 number 로 무손실 변환", () => {
    // NUMERIC(8,3): 5자리 정수 + 3자리 소수 → double 유효자릿수(15) 내 무손실.
    expect(numCoord("12345.678")).toBe(12345.678);
    expect(numCoord("0.001")).toBe(0.001);
    // NUMERIC(4,3) quality_score
    expect(numCoord("0.875")).toBe(0.875);
  });

  it("NULL/undefined/비유한값은 undefined(payload 생략 → v2 기본값 보존)", () => {
    expect(numCoord(null)).toBeUndefined();
    expect(numCoord(undefined)).toBeUndefined();
    expect(numCoord("not-a-number")).toBeUndefined();
    expect(numCoord(Number.NaN)).toBeUndefined();
  });
});

describe("seatCoordFields — go seat row → SeatUpsertInput 좌표 부분", () => {
  it("모든 좌표 필드를 정규화해 담는다", () => {
    expect(
      seatCoordFields({
        x: "100.250",
        y: "-40.125",
        label: "A-1",
        qualityScore: "0.750",
        isObstructed: true,
      }),
    ).toEqual({
      x: 100.25,
      y: -40.125,
      label: "A-1",
      quality_score: 0.75,
      is_obstructed: true,
    });
  });

  it("NULL x/y/quality_score 는 undefined 로 생략(v2 기본값 파괴 방지) — label=null·is_obstructed=false 폴백", () => {
    const out = seatCoordFields({
      x: null,
      y: null,
      label: null,
      qualityScore: null,
      isObstructed: null,
    });
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
    expect(out.quality_score).toBeUndefined();
    expect(out.label).toBeNull();
    expect(out.is_obstructed).toBe(false);
  });
});

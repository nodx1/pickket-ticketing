import { describe, expect, it } from "vitest";

import {
  countSellableByTier,
  countSellableSeats,
  generateFigmaSeats,
  generateGridSeats,
  generateSeatsFromCanvas,
  rowToNumber,
  seatExternalRef,
  seatRefPrefix,
  toSeatUpsertInputs,
} from "./seat-generator";

const MAP = "11111111-1111-4111-8111-111111111111";

describe("seatExternalRef — 결정적 좌석키(레벨2 T1: go seat uuid 대체)", () => {
  it("같은 자연키는 항상 같은 ref (재저장 멱등의 근거)", () => {
    expect(seatExternalRef(MAP, "A구역", "A", "1")).toBe(seatExternalRef(MAP, "A구역", "A", "1"));
  });

  it("맵이 다르면 ref 도 다르다 (v2 external_ref 전역 UNIQUE 충돌 방지)", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    expect(seatExternalRef(MAP, "A", "A", "1")).not.toBe(seatExternalRef(other, "A", "A", "1"));
  });

  it("자연키 경계가 모호하지 않다 — ('A1','B','1') 와 ('A','1B','1') 는 다른 좌석", () => {
    expect(seatExternalRef(MAP, "A1", "B", "1")).not.toBe(seatExternalRef(MAP, "A", "1B", "1"));
  });

  it("v2 Seat.external_ref(String(100)) 안에 들어간다 — 섹션명이 길어도 해시라 길이 고정", () => {
    const ref = seatExternalRef(MAP, "아주아주긴구역이름".repeat(20), "AA", "999");
    expect(ref.length).toBeLessThanOrEqual(100);
    expect(ref.startsWith(seatRefPrefix(MAP))).toBe(true);
  });
});

describe("rowToNumber — 행 라벨 → v2 row_number(int)", () => {
  it("A→1, B→2, AA→27, 숫자 문자열은 그대로", () => {
    expect(rowToNumber("A")).toBe(1);
    expect(rowToNumber("B")).toBe(2);
    expect(rowToNumber("AA")).toBe(27);
    expect(rowToNumber("12")).toBe(12);
  });
});

describe("generateFigmaSeats — 피그마 캔버스에서 좌석 파생", () => {
  const sections = [
    {
      name: "A",
      x: 100,
      y: 200,
      kind: "assigned" as const,
      rows: 2,
      seatsPerRow: 3,
      tierId: "tier-1",
      blockedPositions: ["0-0"], // A행 1번 차단
    },
    { name: "S", x: 0, y: 0, kind: "standing" as const, capacity: 40, tierId: "tier-2" },
    { name: "무대", x: 0, y: -200, kind: "stage" as const },
    { name: "콘솔", x: 300, y: 0, kind: "console" as const },
  ];

  it("assigned 섹션만 좌석 행을 만들고 stage/console 은 무시한다", () => {
    const layout = generateFigmaSeats(MAP, sections);
    expect(layout.seats).toHaveLength(6); // 2행 × 3석
    expect(new Set(layout.seats.map((s) => s.section))).toEqual(new Set(["A"]));
  });

  it("standing 은 좌석 없이 정원만 집계한다(tier 별 + 총합)", () => {
    const layout = generateFigmaSeats(MAP, sections);
    expect(layout.standingTotal).toBe(40);
    expect(layout.standingByTier.get("tier-2")).toBe(40);
  });

  it("blockedPositions 는 blocked 좌석으로 표시되고 판매대상에서 빠진다", () => {
    const layout = generateFigmaSeats(MAP, sections);
    const blocked = layout.seats.filter((s) => s.blocked);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ section: "A", row: "A", seatNumber: "1" });
    expect(countSellableSeats(layout)).toBe(5);
  });

  it("회전(rotation)이 좌표에 반영된다 — 0도와 90도 결과가 다르다", () => {
    const flat = generateFigmaSeats(MAP, [{ ...sections[0], rotation: 0 }]).seats[0];
    const spun = generateFigmaSeats(MAP, [{ ...sections[0], rotation: 90 }]).seats[0];
    expect({ x: spun.x, y: spun.y }).not.toEqual({ x: flat.x, y: flat.y });
  });

  it("같은 캔버스를 두 번 생성하면 완전히 동일하다(재저장이 중복을 만들지 않는 근거)", () => {
    expect(generateFigmaSeats(MAP, sections)).toEqual(generateFigmaSeats(MAP, sections));
  });
});

describe("generateGridSeats — 격자 캔버스", () => {
  it("섹션×행×열 만큼 좌석을 만들고 tier 는 미배정이다", () => {
    const layout = generateGridSeats(MAP, {
      sections: ["1층", "2층"],
      rowsPerSection: 2,
      seatsPerRow: 3,
    });
    expect(layout.seats).toHaveLength(12);
    expect(layout.seats.every((s) => s.tierId === null)).toBe(true);
  });

  it("불완전한 격자 스펙이면 빈 레이아웃(생성 실패로 터지지 않음)", () => {
    expect(generateGridSeats(MAP, { sections: ["A"] }).seats).toHaveLength(0);
  });
});

describe("generateSeatsFromCanvas — 모드 자동 판별", () => {
  it("figmaLayout 이 있으면 피그마, 없으면 격자로 해석한다", () => {
    const figma = generateSeatsFromCanvas(MAP, {
      figmaLayout: { sections: [{ name: "A", x: 0, y: 0, rows: 1, seatsPerRow: 2 }] },
    });
    expect(figma.seats).toHaveLength(2);

    const grid = generateSeatsFromCanvas(MAP, {
      sections: ["A"],
      rowsPerSection: 1,
      seatsPerRow: 4,
    });
    expect(grid.seats).toHaveLength(4);
  });

  it("캔버스가 없으면 빈 레이아웃 — 삭제/보관 시 좌석 전체 정리 delta 로 쓰인다", () => {
    const layout = generateSeatsFromCanvas(MAP, null);
    expect(layout.seats).toHaveLength(0);
    expect(layout.standingTotal).toBe(0);
  });
});

describe("toSeatUpsertInputs — v2 전송 페이로드", () => {
  const layout = generateFigmaSeats(MAP, [
    {
      name: "A",
      x: 0,
      y: 0,
      kind: "assigned",
      rows: 1,
      seatsPerRow: 2,
      tierId: "tier-1",
      blockedPositions: ["0-1"],
    },
    // tier 미배정 섹션 — v2 는 tier_id 필수라 전송 대상이 아니다.
    { name: "B", x: 50, y: 0, kind: "assigned", rows: 1, seatsPerRow: 2 },
  ]);

  it("tier 미배정 좌석은 제외한다(v2 tier_id 필수 계약)", () => {
    const out = toSeatUpsertInputs(layout.seats);
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.tier_ref === "tier-1")).toBe(true);
  });

  it("차단석은 status='reserved' 로 승격 전송된다(go 'blocked' 소실 방지)", () => {
    const out = toSeatUpsertInputs(layout.seats);
    expect(out.filter((s) => s.status === "reserved")).toHaveLength(1);
    expect(out.filter((s) => s.status === "available")).toHaveLength(1);
  });

  it("row 라벨이 int 로 변환된다(0 붕괴 시 uq_seat_position 충돌)", () => {
    expect(toSeatUpsertInputs(layout.seats).every((s) => s.row_number === 1)).toBe(true);
  });
});

describe("countSellableByTier — tier capacity 산출 입력", () => {
  it("차단석·tier 미배정은 빼고 tier 별로 센다", () => {
    const layout = generateFigmaSeats(MAP, [
      {
        name: "A",
        x: 0,
        y: 0,
        kind: "assigned",
        rows: 1,
        seatsPerRow: 3,
        tierId: "t1",
        blockedPositions: ["0-2"],
      },
      { name: "B", x: 0, y: 0, kind: "assigned", rows: 1, seatsPerRow: 2 },
    ]);
    const byTier = countSellableByTier(layout);
    expect(byTier.get("t1")).toBe(2);
    expect(byTier.size).toBe(1);
  });
});

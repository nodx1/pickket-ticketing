import { describe, expect, it } from "vitest";

import { toOrganizerLines } from "./organizer-lines";

describe("toOrganizerLines", () => {
  it("🔴 역할명이 값에 붙지 않는다 — 종전엔 '주최자 / 주최 비씨카드' 로 두 번 나왔다", () => {
    const lines = toOrganizerLines([{ role: "host", name: "비씨카드" }]);
    expect(lines).toEqual([{ role: "host", label: "주최", names: "비씨카드" }]);
    expect(lines[0].names).not.toContain("주최");
  });

  it("같은 역할의 여러 주최자를 쉼표로 잇는다", () => {
    const lines = toOrganizerLines([
      { role: "host", name: "비씨카드" },
      { role: "host", name: "한경" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].names).toBe("비씨카드, 한경");
  });

  it("🔴 겸직을 행으로 나눠 표현한다 — 협회는 주최 겸 주관이다", () => {
    const lines = toOrganizerLines([
      { role: "host", name: "비씨카드" },
      { role: "host", name: "KLPGA" },
      { role: "coordinator", name: "KLPGA" },
    ]);
    expect(lines).toEqual([
      { role: "host", label: "주최", names: "비씨카드, KLPGA" },
      { role: "coordinator", label: "주관", names: "KLPGA" },
    ]);
  });

  it("주최 → 주관 → 후원 순서로 정렬한다 (입력 순서와 무관)", () => {
    const lines = toOrganizerLines([
      { role: "sponsor", name: "S" },
      { role: "coordinator", name: "C" },
      { role: "host", name: "H" },
    ]);
    expect(lines.map((l) => l.role)).toEqual(["host", "coordinator", "sponsor"]);
  });

  it("같은 역할에 같은 이름이 중복돼도 한 번만 — 데이터 중복이 화면에 새지 않게", () => {
    const lines = toOrganizerLines([
      { role: "host", name: "비씨카드" },
      { role: "host", name: "비씨카드" },
    ]);
    expect(lines[0].names).toBe("비씨카드");
  });

  it("이름 앞뒤 공백을 털어낸다", () => {
    const lines = toOrganizerLines([{ role: "host", name: "  비씨카드  " }]);
    expect(lines[0].names).toBe("비씨카드");
  });

  it.each([
    ["역할이 없음", { name: "X" }],
    ["역할이 잘못됨", { role: "unknown", name: "X" }],
    ["이름이 없음", { role: "host" }],
    ["이름이 문자열 아님", { role: "host", name: 123 }],
    ["이름이 공백뿐", { role: "host", name: "   " }],
    ["null 요소", null],
    ["숫자 요소", 7],
  ])("불량 요소는 버린다 — %s", (_label, entry) => {
    expect(toOrganizerLines([entry])).toEqual([]);
  });

  it("불량 요소가 섞여도 정상 요소는 살린다", () => {
    const lines = toOrganizerLines([null, { role: "host", name: "비씨카드" }, { role: "bad" }]);
    expect(lines).toEqual([{ role: "host", label: "주최", names: "비씨카드" }]);
  });

  describe("폴백 (레거시 이벤트)", () => {
    it("목록이 비면 organizerName 을 주최로 표시한다", () => {
      expect(toOrganizerLines([], "노드엑스")).toEqual([
        { role: "host", label: "주최", names: "노드엑스" },
      ]);
    });

    it.each([undefined, null, "", "   ", 0, {}])(
      "🔴 목록도 폴백도 없으면 빈 배열 — 빈 카드는 '주최자 없음' 처럼 보인다 (%s)",
      (fallback) => {
        expect(toOrganizerLines([], fallback)).toEqual([]);
      },
    );

    it.each([undefined, null, "문자열", 0, {}])("배열이 아니면 폴백을 본다 (%s)", (raw) => {
      expect(toOrganizerLines(raw, "노드엑스")).toHaveLength(1);
    });

    it("🔴 목록이 있으면 폴백을 쓰지 않는다 — 둘 다 나오면 중복 표기가 된다", () => {
      const lines = toOrganizerLines([{ role: "host", name: "비씨카드" }], "노드엑스");
      expect(lines).toHaveLength(1);
      expect(lines[0].names).toBe("비씨카드");
    });
  });
});

import { describe, expect, it } from "vitest";

import { resolveSeatType, showsSeatMapEditor } from "./seat-type";

describe("resolveSeatType", () => {
  it("명시적 unassigned 만 자유입장으로 본다", () => {
    expect(resolveSeatType("unassigned")).toBe("unassigned");
  });

  it("assigned 는 그대로", () => {
    expect(resolveSeatType("assigned")).toBe("assigned");
  });

  it.each([undefined, null, "", "UNASSIGNED", "free", 0, false, {}])(
    "알 수 없는 값 %s 는 assigned — 기존 지정석 행사의 배치도가 사라지면 안 된다",
    (raw) => {
      expect(resolveSeatType(raw)).toBe("assigned");
    },
  );
});

describe("showsSeatMapEditor", () => {
  it("지정석에서만 배치도 에디터를 띄운다", () => {
    expect(showsSeatMapEditor("assigned")).toBe(true);
  });

  it("자유입장에서는 띄우지 않는다 — 그리지 않는 배치도가 화면을 차지하지 않게", () => {
    expect(showsSeatMapEditor("unassigned")).toBe(false);
  });
});

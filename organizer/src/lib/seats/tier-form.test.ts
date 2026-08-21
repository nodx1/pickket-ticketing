import { describe, expect, it } from "vitest";

import {
  TIER_CAPACITY_MAX,
  buildTierPatch,
  buildTierPayload,
  isUnsellableCapacity,
} from "./tier-form";

function input(over: Partial<Parameters<typeof buildTierPayload>[0]> = {}) {
  return { name: "주말권", price: "25000", capacity: "1000", colorHex: "#6c5ce7", ...over };
}

describe("buildTierPayload", () => {
  it("입력한 수량이 그대로 페이로드에 실린다", () => {
    const r = buildTierPayload(input({ capacity: "1000" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 🔴 회귀 방지 — 종전 tier-manager 는 여기에 0 을 하드코딩해 만든 등급이 전부 즉시 매진이었다.
    expect(r.payload.capacity).toBe(1000);
  });

  it("수량을 비우면 0 — 배치도로 채우는 지정석 흐름을 막지 않는다", () => {
    const r = buildTierPayload(input({ capacity: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.capacity).toBe(0);
  });

  it("이름·가격을 그대로 옮기고 이름은 공백을 제거한다", () => {
    const r = buildTierPayload(input({ name: "  주중권  ", price: "15000" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.name).toBe("주중권");
    expect(r.payload.basePrice).toBe(15000);
  });

  it("이름이 공백뿐이면 거부한다", () => {
    const r = buildTierPayload(input({ name: "   " }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("이름");
  });

  it("가격 미입력을 0 으로 흘려보내지 않는다", () => {
    // 빈 가격을 Number("") === 0 으로 통과시키면 무료 등급이 조용히 만들어진다.
    const r = buildTierPayload(input({ price: "" }));
    expect(r.ok).toBe(false);
  });

  it.each(["12.5", "1e3", "12a", "-5", " 1 0 "])("정수가 아닌 수량 %s 를 거부한다", (raw) => {
    expect(buildTierPayload(input({ capacity: raw })).ok).toBe(false);
  });

  it("가격 0(무료 등급)은 허용한다", () => {
    const r = buildTierPayload(input({ price: "0" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.basePrice).toBe(0);
  });

  it("서버 상한을 넘는 수량은 요청 전에 막는다", () => {
    const over = buildTierPayload(input({ capacity: String(TIER_CAPACITY_MAX + 1) }));
    expect(over.ok).toBe(false);
    // 경계값은 통과해야 한다 — off-by-one 으로 상한을 못 쓰게 되면 안 된다.
    expect(buildTierPayload(input({ capacity: String(TIER_CAPACITY_MAX) })).ok).toBe(true);
  });
});

describe("isUnsellableCapacity", () => {
  it("0 은 판매 불가로 판정한다", () => {
    expect(isUnsellableCapacity(0)).toBe(true);
  });

  it("1 장부터는 판매 가능", () => {
    expect(isUnsellableCapacity(1)).toBe(false);
    expect(isUnsellableCapacity(1000)).toBe(false);
  });
});

describe("buildTierPatch", () => {
  const current = { name: "주말권", basePrice: 25000, capacity: 1000 };

  it("바뀐 필드만 담는다", () => {
    const r = buildTierPatch(current, { name: "주말권", price: "25000", capacity: "1200" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).toEqual({ capacity: 1200 });
  });

  it("변경이 없으면 빈 패치 — 호출부가 요청을 생략한다", () => {
    const r = buildTierPatch(current, { name: "주말권", price: "25000", capacity: "1000" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.patch)).toHaveLength(0);
  });

  it("세 필드를 동시에 바꿀 수 있다", () => {
    const r = buildTierPatch(current, { name: "주말권(변경)", price: "30000", capacity: "800" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).toEqual({ name: "주말권(변경)", basePrice: 30000, capacity: 800 });
  });

  it("수량 축소도 패치에 담는다 — 판매분 이하 축소 차단은 서버(409) 몫이다", () => {
    const r = buildTierPatch(current, { name: "주말권", price: "25000", capacity: "10" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch).toEqual({ capacity: 10 });
  });

  it("검증 실패는 그대로 전파한다", () => {
    const r = buildTierPatch(current, { name: "", price: "25000", capacity: "1000" });
    expect(r.ok).toBe(false);
  });
});

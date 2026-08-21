import { describe, expect, it } from "vitest";

import { buildBulkPlaceholder } from "./bulk-placeholder";
import { parseRecipients } from "./parse-recipients";

/**
 * 🔴 예시는 **그대로 복사해도 통과해야 한다.** 통과 못 하는 예시는 안내가 아니라 함정이다.
 * 실사고: 행사가 8월인데 예시가 `2026-10-03` 로 하드코딩돼 있어, 복사하면 전건 거부됐다.
 */
describe("buildBulkPlaceholder", () => {
  const days = ["2026-08-20", "2026-08-21", "2026-08-22"];

  it("🔴 지정일권 예시를 그대로 붙여넣으면 검증을 통과한다", () => {
    const text = buildBulkPlaceholder(true, days);
    const r = parseRecipients(text, { requireAdmissionDay: true, validDays: days });
    expect(r.errors).toEqual([]);
    expect(r.recipients).toHaveLength(2);
  });

  it("🔴 예시 날짜가 이 행사의 입장일 안에 있다", () => {
    const text = buildBulkPlaceholder(true, days);
    for (const d of days.filter((x) => text.includes(x))) expect(days).toContain(d);
    expect(text).not.toMatch(/2026-10-/); // 옛 하드코딩 잔재
  });

  it("입장일이 하루뿐이면 두 줄 모두 그 날짜를 쓴다", () => {
    const one = ["2026-08-20"];
    const text = buildBulkPlaceholder(true, one);
    const r = parseRecipients(text, { requireAdmissionDay: true, validDays: one });
    expect(r.errors).toEqual([]);
  });

  it("단일권 예시도 그대로 통과한다(날짜 열 없음)", () => {
    const r = parseRecipients(buildBulkPlaceholder(false, []), { requireAdmissionDay: false });
    expect(r.errors).toEqual([]);
    expect(r.recipients).toHaveLength(2);
  });

  it("입장일 정보를 못 받으면 형식 안내로 폴백한다", () => {
    expect(buildBulkPlaceholder(true, [])).toContain("YYYY-MM-DD");
  });
});

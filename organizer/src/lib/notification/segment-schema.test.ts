import { describe, expect, it } from "vitest";

import {
  assertNoRetiredSegmentKeys,
  RetiredSegmentKeyError,
  segmentSchema,
} from "./segment-schema";

/**
 * 2.6-Med2 회귀: 캠페인·메시지가 공유하는 세그먼트 화이트리스트. 임의 필드/타입은 거부해
 * 저장 시점부터 자유 SQL·과대발송을 차단한다.
 */
describe("segmentSchema (2.6-Med2 공용 화이트리스트)", () => {
  it("허용 필드만 통과", () => {
    const r = segmentSchema.safeParse({ status: "checked_in", lotteryWon: true });
    expect(r.success).toBe(true);
  });

  it("잘못된 enum 값 거부", () => {
    expect(segmentSchema.safeParse({ status: "everyone" }).success).toBe(false);
  });

  it("productIds/attendeeIds 는 uuid 배열만", () => {
    expect(segmentSchema.safeParse({ productIds: ["not-a-uuid"] }).success).toBe(false);
    expect(
      segmentSchema.safeParse({ attendeeIds: ["11111111-1111-4111-8111-111111111111"] }).success,
    ).toBe(true);
  });

  it("타입 오류(문자열 lotteryWon) 거부", () => {
    expect(segmentSchema.safeParse({ lotteryWon: "yes" }).success).toBe(false);
  });

  it("빈 세그먼트 허용(전체 대상)", () => {
    expect(segmentSchema.safeParse({}).success).toBe(true);
  });
});

/**
 * W3-MSG 회귀: 폐기된 CRM 세그먼트(crmTiers·crmTags)는 **조용히 버려지면 안 된다**.
 *
 * zod object 는 unknown 키를 strip 하므로, 스키마에서 필드만 지우면 "VIP 만"으로 지정한
 * 발송이 조건 없는 **전체 발송**으로 확대된다(과대발송). 그래서 파싱 전에 명시 거부한다.
 */
describe("폐기 세그먼트 키 거부 (W3-MSG, 과대발송 차단)", () => {
  it("crmTiers 가 들어오면 던진다", () => {
    expect(() => assertNoRetiredSegmentKeys({ crmTiers: ["vip"] })).toThrow(RetiredSegmentKeyError);
  });

  it("crmTags 가 들어오면 던진다", () => {
    expect(() => assertNoRetiredSegmentKeys({ crmTags: ["단골"] })).toThrow(RetiredSegmentKeyError);
  });

  it("두 키가 동시에 오면 둘 다 보고한다", () => {
    try {
      assertNoRetiredSegmentKeys({ crmTiers: [], crmTags: [] });
      throw new Error("던졌어야 한다");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RetiredSegmentKeyError);
      expect((err as RetiredSegmentKeyError).keys).toEqual(["crmTiers", "crmTags"]);
    }
  });

  it("🔴 zod 가 폐기 키를 조용히 strip 한다는 사실 자체를 못박는다", () => {
    // 이 동작이 바로 명시 거부가 필요한 이유다. 스키마만 고치고 거부를 빼면
    // 좁히는 필터가 사라진 채로 파싱이 **성공**한다.
    const parsed = segmentSchema.parse({ status: "checked_in", crmTiers: ["vip"] });
    expect(parsed).toEqual({ status: "checked_in" });
  });

  it("정상 세그먼트·비객체는 통과", () => {
    expect(() => assertNoRetiredSegmentKeys({ status: "checked_in" })).not.toThrow();
    expect(() => assertNoRetiredSegmentKeys(undefined)).not.toThrow();
    expect(() => assertNoRetiredSegmentKeys(null)).not.toThrow();
    expect(() => assertNoRetiredSegmentKeys([{ crmTiers: ["vip"] }])).not.toThrow();
  });
});

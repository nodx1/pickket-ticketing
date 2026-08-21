import { describe, expect, it } from "vitest";
import { resolveOrganizerRef } from "@/lib/v2/commerce-client";

// 레벨2 영역D 앵커 전환 회귀: resolveOrganizerRef 는 이제 go DB 를 조회하지 않고
// 세션의 v2UserId(=JWT sub=v2 User.id)를 그대로 반환하는 순수 함수다.
// 호출부는 null 시 session.accountId 로 폴백(v2 go_account_id 재해석)한다.
describe("resolveOrganizerRef (앵커 전환)", () => {
  it("세션 v2UserId 를 그대로 반환한다(go DB 미조회, 동기)", () => {
    const v2UserId = "11111111-1111-4111-8111-111111111111";
    expect(resolveOrganizerRef(v2UserId)).toBe(v2UserId);
  });

  it("v2UserId 가 null 이면 null 을 반환(호출부 account_id 폴백 유도)", () => {
    expect(resolveOrganizerRef(null)).toBeNull();
  });

  it("v2UserId 가 undefined(레거시 토큰)면 null 을 반환", () => {
    expect(resolveOrganizerRef(undefined)).toBeNull();
  });

  it("Promise 가 아니라 동기 값을 반환한다(await 제거 계약)", () => {
    const r = resolveOrganizerRef("22222222-2222-4222-8222-222222222222");
    expect(r).not.toBeInstanceOf(Promise);
  });
});

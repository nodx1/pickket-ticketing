/**
 * 🔴 초대권·수동발권 판정 — **매출로 세면 안 되는 주문**을 가른다 (2026-08-11).
 *
 * 목록은 결제수단조차 안 받아 초대권·수동발권·현장결제가 한 덩어리였다.
 * 실측: 확정 주문 27건이 결제 시도 0건이다. 대회 중 이걸로 판단하면 안 된다.
 *
 * ⚠️ 판정과 **문구**를 함께 여기서 준다. 상세와 목록이 각자 적으면 다음에 한쪽만
 *    고쳐진다 — 오늘 `v2ErrorCode` 가 정확히 그렇게 두 벌로 갈려 죽어 있었다.
 */
import { describe, expect, it } from "vitest";
import { ISSUE_SOURCE_LABEL, issueSourceBadge, resolveIssueSource } from "./issue-source";

describe("판정", () => {
  it("초대권", () => {
    expect(resolveIssueSource({ isInvitation: true })).toEqual({
      kind: "invitation",
      label: "초대권 (무료)",
    });
  });

  it("수동발권", () => {
    expect(resolveIssueSource({ isManualIssue: true })).toEqual({
      kind: "manual",
      label: "주최자 수동발권",
    });
  });

  it("🔴 겹치면 초대권이 이긴다 — 상세 화면이 쓰던 순서 그대로", () => {
    expect(resolveIssueSource({ isInvitation: true, isManualIssue: true }).kind).toBe("invitation");
  });

  it("둘 다 false 면 실판매", () => {
    expect(resolveIssueSource({ isInvitation: false, isManualIssue: false })).toEqual({ kind: "sale" });
  });
});

describe("🔴 「모름」과 「아님」은 다르다", () => {
  it("🔴 undefined 면 아무것도 단정하지 않는다 — 배지를 안 붙인다", () => {
    // v2 앵커 미연결·구버전 응답. 아닌 주문을 초대권으로 보이게 하는 쪽이 훨씬 비싸다.
    expect(issueSourceBadge({})).toBeNull();
    expect(issueSourceBadge({ isInvitation: undefined, isManualIssue: undefined })).toBeNull();
  });

  it("🔴 null 도 모름으로 본다", () => {
    expect(issueSourceBadge({ isInvitation: null, isManualIssue: null })).toBeNull();
  });

  it("🔴 truthy 검사로 흘리지 않는다 — 문자열 'false' 가 와도 배지가 안 붙는다", () => {
    // 응답이 문자열로 오는 사고를 대비한다(JSON 경유에서 실제로 겪는 부류다).
    expect(issueSourceBadge({ isInvitation: "false" as unknown as boolean })).toBeNull();
    expect(issueSourceBadge({ isInvitation: 1 as unknown as boolean })).toBeNull();
  });
});

describe("🔴 목록 배지 — 실판매에는 아무것도 안 붙인다", () => {
  it("실판매는 null", () => {
    expect(issueSourceBadge({ isInvitation: false, isManualIssue: false })).toBeNull();
  });

  it("초대권·수동발권만 문구가 있다", () => {
    expect(issueSourceBadge({ isInvitation: true })).toBe("초대권 (무료)");
    expect(issueSourceBadge({ isManualIssue: true })).toBe("주최자 수동발권");
  });

  it("🔴 문구가 상수 하나에서만 나온다 — 상세와 목록이 갈리지 않게", () => {
    expect(resolveIssueSource({ isInvitation: true })).toMatchObject({
      label: ISSUE_SOURCE_LABEL.invitation,
    });
    expect(resolveIssueSource({ isManualIssue: true })).toMatchObject({
      label: ISSUE_SOURCE_LABEL.manual,
    });
  });

  it("🔴 실판매 갈래에는 라벨이 아예 없다 — 상세가 결제수단으로 폴백할 수 있게", () => {
    const src = resolveIssueSource({ isInvitation: false });
    expect(src.kind).toBe("sale");
    expect("label" in src, "실판매에 라벨이 생기면 상세가 결제수단을 못 쓴다").toBe(false);
  });
});

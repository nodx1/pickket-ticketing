/**
 * 주문이 **어떻게 나왔나** — 초대권 · 수동발권 · 실판매.
 *
 * ## 🔴 왜 공통 함수인가 (2026-08-11)
 * 주문 **상세**는 이미 이 판정을 하고 있었고, **목록**은 결제수단조차 안 받아
 * 초대권·수동발권·현장결제가 한 덩어리로 보였다. 실측: 확정 주문 27건이 결제 시도 0건이다.
 * 목록으로 「몇 장 팔렸나」를 보면 **매출이 부풀어 보인다.**
 *
 * 판정을 두 화면에 복사하면 다음에 한쪽만 고쳐진다 — 오늘 `v2ErrorCode` 가 정확히 그렇게
 * 두 벌로 갈려 죽어 있었다. 그래서 **문구까지 여기서** 준다.
 *
 * ## 🔴 `=== true` 인 이유 — 「모름」과 「아님」은 다르다
 * ```
 * true       그렇다
 * false      아니다
 * undefined  🔴 모른다 (v2 앵커 미연결·구버전 응답) → 아무것도 붙이지 않는다
 * ```
 * truthy 검사로 흘리면 반대로 새지는 않지만, `!== false` 로 쓰면 **모르는 주문이 전부
 * 초대권으로 보인다.** 아닌 주문을 그렇게 보이게 하는 쪽이 훨씬 비싸다.
 *
 * ⚠️ 우선순위: **초대권 → 수동발권 → 실판매.** 두 표식은 발급 경로가 겹치지 않지만,
 *    겹치면 초대권이 이긴다(상세 화면이 쓰던 순서를 그대로 옮겼다).
 */

export interface IssueSourceInput {
  isInvitation?: boolean | null;
  isManualIssue?: boolean | null;
}

export type IssueSource =
  /** 초대권(0원). 매출로 세면 안 된다. */
  | { kind: "invitation"; label: string }
  /** 주최자가 손으로 발권한 주문. 결제가 일어나지 않았다. */
  | { kind: "manual"; label: string }
  /**
   * 실판매(또는 모름) — 🔴 **여기엔 라벨이 없다.**
   * 목록은 아무것도 안 붙이고, 상세는 결제수단 라벨로 폴백한다.
   */
  | { kind: "sale" };

export const ISSUE_SOURCE_LABEL = {
  invitation: "초대권 (무료)",
  manual: "주최자 수동발권",
} as const;

export function resolveIssueSource(order: IssueSourceInput): IssueSource {
  if (order.isInvitation === true) return { kind: "invitation", label: ISSUE_SOURCE_LABEL.invitation };
  if (order.isManualIssue === true) return { kind: "manual", label: ISSUE_SOURCE_LABEL.manual };
  return { kind: "sale" };
}

/**
 * 목록 배지 문구. **실판매·모름이면 `null`** — 아무것도 덧붙이지 않는다.
 *
 * ⚠️ 실판매에 「카드」 같은 배지를 달지 않는다. 목록에서 눈에 띄어야 하는 것은
 *    **매출로 세면 안 되는 주문**이지, 정상 주문이 아니다.
 */
export function issueSourceBadge(order: IssueSourceInput): string | null {
  const src = resolveIssueSource(order);
  return src.kind === "sale" ? null : src.label;
}

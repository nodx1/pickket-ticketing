/**
 * 초대권 **재발송을 걸어도 되는 행인가**.
 *
 * ## 🔴 왜 함수로 빼는가
 * 잘못 만들면 결과가 **중복 발송**이다. 손님이 초대권을 두 장 받고, 알림톡은 회수할 수
 * 없다. 표 행별 버튼(A-1)과 배너 일괄 버튼(A-2)이 **같은 판정**을 써야 하는데, 각자
 * 조건을 적으면 한쪽만 고쳐져 두 경로가 갈린다.
 *
 * ## 규칙 — 기본값은 "안 보낸다"
 * ```
 * sentAt 있음        → 안 보낸다   🔴 이미 받은 사람이다. 누르면 한 장 더 간다
 * status revoked     → 안 보낸다   회수된 초대권이다(티켓도 취소됨)
 * status checked_in  → 안 보낸다   이미 입장했다
 * status sent|viewed → 안 보낸다   나갔다(sentAt 이 비어도 상태가 말해준다)
 * status issued      → 보낸다      큐에 안 들어갔거나 멈춰 있다  ← 이번 5건
 * status failed      → 보낸다      실패했다. 다시 시도할 값이 있다
 * 그 밖의 status     → 안 보낸다   모르는 상태를 낙관하지 않는다
 * ```
 *
 * ⚠️ `sentAt` 과 `status` 를 **둘 다** 본다. 한쪽만 보면 뚫린다 —
 *    `status:"issued"` 인데 `sentAt` 이 찍힌 행(발송 후 상태 전파가 늦은 경우)에
 *    버튼이 뜨면 그게 곧 중복 발송이다.
 */

/** 재발송을 시도할 수 있는 상태. 이 목록에 **없는 것은 전부 불가**다. */
const RESENDABLE_STATUSES = new Set(["issued", "failed"]);

export interface ResendCandidate {
  status: string;
  /** 발송 시각. 값이 있으면 **이미 받은 것**이므로 무조건 제외한다. */
  sentAt?: string | null;
  /**
   * 큐 상태. `"sending"` 이면 제외한다 — 아래 주석 참고.
   *
   * ⚠️ `undefined`(구버전 v2)면 이 층은 판정하지 않는다. 정보가 없다고 막으면
   *    구버전에서 버튼이 통째로 사라진다.
   */
  dispatchStatus?: string | null;
  /**
   * 🔴 보낸 대상이 **지금 주인이 아니다**(양도 뒤 옛 번호로 나감).
   *
   * `sentAt` 이 찍혀 있어도 그 손님은 **못 받았다**. `true` 면 재발송을 열어야 한다 —
   * 안 열면 화면에 복구 수단이 없다(2026-08-12 prod 8건).
   *
   * ⚠️ `undefined`(구버전 v2)는 모름이다. 모름은 예외를 열지 않는다 —
   *    모름으로 중복 발송을 만들지 않는다.
   */
  dispatchStale?: boolean;
}

/** 이 행에 「재발송」을 노출·실행해도 되는가. */
export function canResendInvitation(row: ResendCandidate): boolean {
  // 🔴 먼저 보낸 흔적부터 본다. 상태가 무엇이든 이미 받았으면 끝이다.
  //    ⚠️ 단, **그 사람에게** 보낸 게 아니면 아직 못 받은 것이다(양도 뒤 옛 번호).
  const wrongRecipient = row.dispatchStale === true;
  if (!wrongRecipient && typeof row.sentAt === "string" && row.sentAt.trim() !== "") {
    return false;
  }

  // 🔴 워커가 **지금 보내는 중**이면 손대지 않는다.
  //    v2 의 재발송은 큐 행을 제자리에서 `queued` 로 되돌리고 claim 을 지운다.
  //    보내는 중인 행에 걸면 그 워커는 그대로 발송하고, 풀린 행을 다른 워커가
  //    또 집어간다 — **손님이 두 장 받는다.** (v2 resend_invitation 실측)
  if (row.dispatchStatus === "sending") return false;

  return RESENDABLE_STATUSES.has(row.status);
}

/**
 * 일괄 재발송 대상 id 목록.
 *
 * 🔴 배너 버튼이 "멈춘 것 전부" 를 보낼 때 쓰는 유일한 출처다. 화면이 따로 필터링하면
 *    행별 버튼과 갈린다.
 */
export function resendableIds<T extends ResendCandidate & { id: string }>(rows: readonly T[]): string[] {
  return rows.filter(canResendInvitation).map((r) => r.id);
}

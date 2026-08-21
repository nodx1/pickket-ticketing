/**
 * 🔴 재발송 판정 — **틀리면 결과가 중복 발송이다.**
 *
 * 배정(2026-08-04): 발주처가 보낸 초대권 5건이 23시간째 안 나갔는데, 화면에 재발송
 * 버튼이 없어 손쓸 방법이 0 이었다(재발송 API 는 종전부터 있었다).
 *
 * ## 기본값은 "안 보낸다"
 * 초대권 알림톡은 **회수할 수 없다.** 두 장 받은 손님에게 사과할 방법이 없으므로,
 * 확실히 안 나간 건에만 버튼을 연다.
 */
import { describe, expect, it } from "vitest";
import { canResendInvitation, resendableIds } from "./resend-policy";

describe("보낸다 — 확실히 안 나간 건만", () => {
  it("발권만 되고 발송 시각이 없으면 보낸다 — 이번 5건이 이 상태다", () => {
    expect(canResendInvitation({ status: "issued", sentAt: null })).toBe(true);
  });

  it("실패한 건은 보낸다 — 다시 시도할 값이 있다", () => {
    expect(canResendInvitation({ status: "failed", sentAt: null })).toBe(true);
  });

  it("sentAt 필드가 아예 없어도 상태로 판정한다", () => {
    expect(canResendInvitation({ status: "issued" })).toBe(true);
  });
});

describe("🔴 안 보낸다 — 이쪽이 기본값이다", () => {
  it("🔴 이미 발송된 건은 안 보낸다 — 누르면 한 장 더 간다", () => {
    expect(canResendInvitation({ status: "sent", sentAt: "2026-08-04T01:00:00Z" })).toBe(false);
  });

  it("🔴 상태가 issued 라도 발송 시각이 찍혔으면 안 보낸다", () => {
    // 발송은 됐는데 상태 전파가 늦은 경우다. 상태만 보면 여기서 뚫린다.
    expect(canResendInvitation({ status: "issued", sentAt: "2026-08-04T01:00:00Z" })).toBe(false);
  });

  it("🔴 실패로 기록됐어도 발송 시각이 있으면 안 보낸다", () => {
    expect(canResendInvitation({ status: "failed", sentAt: "2026-08-04T01:00:00Z" })).toBe(false);
  });

  it("회수된 건은 안 보낸다 — 티켓도 취소된 상태다", () => {
    expect(canResendInvitation({ status: "revoked", sentAt: null })).toBe(false);
  });

  it("입장 완료한 건은 안 보낸다", () => {
    expect(canResendInvitation({ status: "checked_in", sentAt: null })).toBe(false);
  });

  it("열람된 건은 안 보낸다 — 받아서 열어봤다", () => {
    expect(canResendInvitation({ status: "viewed", sentAt: null })).toBe(false);
  });

  it("🔴 모르는 상태는 안 보낸다 — 낙관하지 않는다", () => {
    // 상태가 늘어났을 때 기본값이 "보낸다" 면 새 상태마다 중복 발송 위험이 생긴다.
    expect(canResendInvitation({ status: "queued", sentAt: null })).toBe(false);
    expect(canResendInvitation({ status: "", sentAt: null })).toBe(false);
  });

  /**
   * 🔴 워커가 **지금 보내는 중**인 행에 재발송을 걸면 두 장 나간다.
   *
   * v2 의 재발송은 큐 행을 제자리에서 `queued` 로 되돌리고 `claim_token` 을 지운다.
   * 보내는 중인 행에 걸면 그 워커는 그대로 발송하고, 풀린 행을 다른 워커가 또 집어간다.
   */
  it("🔴 발송 중(sending)인 행은 안 보낸다 — 두 장 나간다", () => {
    expect(canResendInvitation({ status: "issued", sentAt: null, dispatchStatus: "sending" })).toBe(false);
    expect(canResendInvitation({ status: "failed", sentAt: null, dispatchStatus: "sending" })).toBe(false);
  });

  it("큐 대기·미적재·실패는 보낼 수 있다 — 아무도 보내는 중이 아니다", () => {
    expect(canResendInvitation({ status: "issued", sentAt: null, dispatchStatus: "queued" })).toBe(true);
    expect(canResendInvitation({ status: "issued", sentAt: null, dispatchStatus: null })).toBe(true);
    expect(canResendInvitation({ status: "issued", sentAt: null, dispatchStatus: "sent" })).toBe(true);
  });

  it("⚠️ 큐 정보가 없으면(구버전 v2) 이 층은 판정하지 않는다 — 버튼이 통째로 사라지면 안 된다", () => {
    expect(canResendInvitation({ status: "issued", sentAt: null })).toBe(true);
  });

  it("빈 문자열 sentAt 은 발송된 것이 아니다", () => {
    expect(canResendInvitation({ status: "issued", sentAt: "" })).toBe(true);
    expect(canResendInvitation({ status: "issued", sentAt: "   " })).toBe(true);
  });
});

/**
 * 🔴 허용 목록 자체를 못박는다 (2026-08-04, 배포 세션 지적).
 *
 * 종전 테스트는 `sent` 를 **항상 `sentAt` 과 함께** 넣어 확인했다. 그래서
 * `RESENDABLE_STATUSES` 에 `"sent"` 를 끼워 넣어도 **아무도 안 잡았다**(87건 전부 통과).
 * 독스트링은 "상태가 말해준다(sentAt 이 비어도)" 라고 적어놨는데 그 층이 미검증이었다.
 *
 * ⚠️ 오늘 고친 사고가 정확히 이 형태다 — 허용 목록이 조용히 넓어지는 것.
 *    그래서 **모든 상태 × sentAt 없음** 조합을 한 표에 못박는다.
 */
describe("🔴 상태별 허용표 — 목록을 넓히면 여기서 죽는다", () => {
  /** 화면이 아는 상태 전부(`STATUS_LABELS` 와 같은 집합). sentAt 은 **전부 비어 있다**. */
  const TABLE: Array<[status: string, allowed: boolean]> = [
    ["issued", true],
    ["failed", true],
    ["sent", false],
    ["viewed", false],
    ["checked_in", false],
    ["revoked", false],
  ];

  it("🔴 sentAt 이 비어도 상태만으로 갈린다", () => {
    for (const [status, allowed] of TABLE) {
      expect(canResendInvitation({ status, sentAt: null }), `status=${status}`).toBe(allowed);
    }
  });

  it("🔴 허용되는 상태는 정확히 둘뿐이다 — 셋째가 생기면 실패한다", () => {
    const allowed = TABLE.filter(([, ok]) => ok).map(([s]) => s);
    expect(allowed).toEqual(["issued", "failed"]);
    // 표에 없는 상태가 통과하면 그것도 목록이 넓어진 것이다.
    for (const unknown of ["queued", "pending", "dispatched", "SENT", "Issued"]) {
      expect(canResendInvitation({ status: unknown, sentAt: null }), unknown).toBe(false);
    }
  });
});

describe("🔴 일괄 대상 — 행별 버튼과 같은 판정이어야 한다", () => {
  const rows = [
    { id: "a", status: "issued", sentAt: null },
    { id: "b", status: "sent", sentAt: "2026-08-04T01:00:00Z" },
    { id: "c", status: "failed", sentAt: null },
    { id: "d", status: "revoked", sentAt: null },
    { id: "e", status: "issued", sentAt: "2026-08-04T01:00:00Z" },
  ];

  it("보낼 수 있는 것만 고른다", () => {
    expect(resendableIds(rows)).toEqual(["a", "c"]);
  });

  it("🔴 행별 판정과 한 글자도 갈리지 않는다", () => {
    // 두 경로가 갈리면 화면에 버튼이 없던 행까지 일괄에서 나간다.
    const byRow = rows.filter(canResendInvitation).map((r) => r.id);
    expect(resendableIds(rows)).toEqual(byRow);
  });

  it("대상이 없으면 빈 배열", () => {
    expect(resendableIds([{ id: "x", status: "sent", sentAt: "2026-08-04T01:00:00Z" }])).toEqual([]);
    expect(resendableIds([])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { canResendInvitation, resendableIds } from "@/lib/invitations/resend-policy";

/**
 * 🔴 「보냈다」와 「그 사람에게 보냈다」는 다르다 (2026-08-12 실사고).
 *
 * 양도는 주인을 바꾸고 `sent_at` 을 지워 재발송 대상으로 되돌린다. 그런데 발송이
 * 옛 스냅샷 번호로 나가면서 `sent_at` 을 **다시 찍었다**. 화면 정책은 "이미 받았다"로
 * 읽어 재발송 버튼을 감췄고, 손님은 못 받았는데 **복구 수단이 화면에서 사라졌다.**
 * prod 8건(서범원4·최보근2·김연수1·서낙원1)이 그 상태로 방치됐고, 배포 세션이
 * 서버에서 직접 눌러야 했다.
 */
const base = { status: "issued", sentAt: null as string | null, dispatchStatus: "queued" };

describe("🔴 옛 주인에게 간 건은 다시 보낼 수 있어야 한다", () => {
  it("🔴 sentAt 이 있어도 dispatchStale 이면 재발송 가능", () => {
    expect(
      canResendInvitation({ ...base, sentAt: "2026-08-11T17:03:00Z", dispatchStale: true }),
      "손님은 못 받았는데 화면에 복구 수단이 없다",
    ).toBe(true);
  });

  it("정상 발송건은 종전대로 막는다 — 누르면 한 장 더 간다", () => {
    expect(canResendInvitation({ ...base, sentAt: "2026-08-11T17:03:00Z" })).toBe(false);
    expect(
      canResendInvitation({ ...base, sentAt: "2026-08-11T17:03:00Z", dispatchStale: false }),
    ).toBe(false);
  });

  it("🔴 모름(undefined)은 예외를 열지 않는다 — 구버전 v2 에서 중복 발송 금지", () => {
    expect(
      canResendInvitation({ ...base, sentAt: "2026-08-11T17:03:00Z", dispatchStale: undefined }),
    ).toBe(false);
  });

  it("🔴 보내는 중이면 stale 이어도 막는다 — 손님이 두 장 받는다", () => {
    expect(
      canResendInvitation({
        ...base, sentAt: "2026-08-11T17:03:00Z", dispatchStale: true, dispatchStatus: "sending",
      }),
    ).toBe(false);
  });

  it("🔴 회수된 표는 stale 이어도 되살아나지 않는다", () => {
    expect(
      canResendInvitation({
        ...base, status: "revoked", sentAt: "2026-08-11T17:03:00Z", dispatchStale: true,
      }),
    ).toBe(false);
  });

  it("아직 안 보낸 건은 종전대로 재발송 가능", () => {
    expect(canResendInvitation({ ...base, sentAt: null })).toBe(true);
  });

  it("목록에서 stale 건만 골라낸다", () => {
    const rows = [
      { id: "a", ...base, sentAt: "2026-08-11T17:00:00Z", dispatchStale: true },
      { id: "b", ...base, sentAt: "2026-08-11T17:00:00Z" },
      { id: "c", ...base, sentAt: null },
    ];
    expect(resendableIds(rows)).toEqual(["a", "c"]);
  });
});

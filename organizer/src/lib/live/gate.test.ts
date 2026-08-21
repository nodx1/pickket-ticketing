/**
 * 🔴 라이브 게이트 둘 — **입장 판정**과 **리허설 차단**.
 *
 * 배선 검증은 `tickets/[ticketNumber]/live-gate.test.tsx`(페이지 단위)와
 * `live-view.test.tsx`(화면 단위)가 한다. 여기서는 **판정 규칙 자체**를 못 박는다.
 */
import { describe, expect, it } from "vitest";
import { isSpectatorSafe, shouldShowLive } from "./gate";

describe("🔴 입장 판정 — admitted_today 하나만 본다", () => {
  it("오늘 입장했으면 라이브", () => {
    expect(shouldShowLive({ admitted_today: true })).toBe(true);
  });

  it("🔴 다일권 2일차 — 어제 입장 기록이 남아 있어도 오늘 미입장이면 QR", () => {
    // 주중권은 목·금 이틀. `checked_in_at` 으로 판정하면 2일차 아침에 QR 이 사라진다.
    expect(shouldShowLive({ admitted_today: false, checked_in_at: "2026-08-20T01:00:00Z" })).toBe(
      false,
    );
  });

  it("🔴 모르면(구버전 v2) QR — 입장 전인 사람의 QR 을 지우면 안 된다", () => {
    expect(shouldShowLive({})).toBe(false);
    expect(shouldShowLive({ admitted_today: undefined })).toBe(false);
    expect(shouldShowLive({ admitted_today: null })).toBe(false);
  });

  it("🔴 checked_in_at 만으로는 절대 통과하지 않는다", () => {
    expect(shouldShowLive({ checked_in_at: "2026-08-20T01:00:00Z" })).toBe(false);
  });
});

describe("🔴 리허설 차단 — fail-closed", () => {
  it("리허설이 아님이 확인되면 보여준다", () => {
    expect(isSpectatorSafe({ is_rehearsal: false })).toBe(true);
  });

  it("🔴 리허설이면 막는다", () => {
    expect(isSpectatorSafe({ is_rehearsal: true })).toBe(false);
  });

  it("🔴 모르면 막는다 — 필드를 빠뜨린 배포 하나로 다른 대회 스코어가 새면 안 된다", () => {
    // ⚠️ `!== true` 로 쓰면 여기서 통과해버린다. 손해가 비대칭이라 fail-closed 로 둔다.
    expect(isSpectatorSafe({}), "확인 안 된 데이터를 관중에게 보여줬다").toBe(false);
    expect(isSpectatorSafe({ is_rehearsal: undefined })).toBe(false);
  });
});

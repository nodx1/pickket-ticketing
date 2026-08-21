import { describe, expect, it } from "vitest";

import { resolveTicketUsability, ticketStatusLabel, type V2TicketStatus } from "./usability";

/**
 * 🔴 환불한 구매자에게 **QR 이 그대로 보이던 것**을 고정한다 (2026-08-01 실사고).
 *
 * 김상윤님이 환불을 마쳤는데 티켓 화면의 QR 이 살아 있었다. 게이트는 정상 거부하지만
 * (`admission_service.py` 가 CANCELLED/EXPIRED 를 첫 관문에서 막는다) 화면이
 * "쓸 수 있는 티켓" 처럼 보였다 — **환불한 사람을 현장에 나타나게 만드는 화면**이다.
 *
 * 값 하나하나가 아니라 **v2 상태 6종 전부**를 본다. 하나라도 빠지면 그 상태에서
 * 무슨 일이 일어나는지 아무도 모른다.
 */
const ALL: V2TicketStatus[] = ["pending", "active", "used", "transferred", "cancelled", "expired"];

describe("resolveTicketUsability — v2 상태 6종 전수", () => {
  it.each([
    ["pending", true, "결제 확인 중"],
    ["active", true, "사용 가능"],
    ["used", true, "입장 완료"],
    ["transferred", false, "양도됨"],
    ["cancelled", false, "환불·취소"],
    ["expired", false, "만료"],
  ] as const)("%s → 사용가능 %s · 라벨 %s", (status, usable, label) => {
    const u = resolveTicketUsability(status);
    expect(u.usable).toBe(usable);
    expect(u.label).toBe(label);
  });

  it("🔴 6종이 하나도 빠지지 않았다 — 빠진 상태는 아래 fail-closed 로 떨어진다", () => {
    for (const s of ALL) {
      expect(resolveTicketUsability(s).label, `라벨 없음: ${s}`).not.toBe("확인 필요");
    }
  });

  /**
   * ⚠️ 실수로 막기 쉬운 두 자리. 막으면 **입장 직전에 티켓이 안 열린다.**
   */
  it("🔴 used 는 쓸 수 있다 — KLPGA 는 daypass 라 2일차에 같은 티켓으로 들어온다", () => {
    // `admission_service` 가 single/daypass 입장 시 티켓을 USED 로 바꾼다.
    // 여기서 막으면 2일차 관객이 티켓을 못 연다.
    expect(resolveTicketUsability("used").usable).toBe(true);
  });

  it("🔴 pending 도 쓸 수 있다 — 무통장 확정이 비동기라 발권 직후 pending 이다", () => {
    // 게이트도 PENDING 을 받아준다(`checkin_service.py:220`).
    expect(resolveTicketUsability("pending").usable).toBe(true);
  });
});

describe("못 쓰는 티켓 문구", () => {
  it("환불 티켓은 이유와 다음 행동을 준다 — 빈 화면은 문의를 만든다", () => {
    const u = resolveTicketUsability("cancelled");
    expect(u.title).toContain("환불");
    expect(u.detail).toBeTruthy();
  });

  it.each(["transferred", "cancelled", "expired"])("%s 는 title·detail 이 모두 있다", (s) => {
    const u = resolveTicketUsability(s);
    expect(u.title, `title 없음: ${s}`).toBeTruthy();
    expect(u.detail, `detail 없음: ${s}`).toBeTruthy();
  });

  it("쓸 수 있는 티켓은 경고 문구를 만들지 않는다", () => {
    for (const s of ["pending", "active", "used"]) {
      expect(resolveTicketUsability(s).title).toBeNull();
    }
  });
});

describe("🔴 fail-closed — 모르는 상태는 막는다", () => {
  /**
   * v2 가 상태를 하나 추가했는데 여기 안 적히면, "모르니까 열어준다" 는
   * **못 쓰는 티켓에 QR 을 띄우는 것**이다. 반대는 문의 한 통이지만 이쪽은 현장 분쟁이다.
   */
  it.each([null, undefined, "", "voided", "refunded", "unknown_future_status"])(
    "%o → 막는다",
    (s) => {
      expect(resolveTicketUsability(s as string).usable).toBe(false);
    },
  );

  it("모르는 상태에도 문구는 준다 — 빈 화면으로 두지 않는다", () => {
    const u = resolveTicketUsability("unknown_future_status");
    expect(u.title).toBeTruthy();
    expect(u.detail).toBeTruthy();
  });
});

describe("ticketStatusLabel — 원시 영문값이 화면에 새지 않는다", () => {
  it("6종 어느 것도 영문 원문을 그대로 돌려주지 않는다", () => {
    for (const s of ALL) {
      expect(ticketStatusLabel(s), `원문 노출: ${s}`).not.toBe(s);
      expect(/^[a-z_]+$/.test(ticketStatusLabel(s)), `영문 라벨: ${s}`).toBe(false);
    }
  });

  it("대소문자·공백이 섞여 와도 같은 라벨", () => {
    expect(ticketStatusLabel(" CANCELLED ")).toBe("환불·취소");
  });
});

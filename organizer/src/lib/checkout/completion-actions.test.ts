/**
 * 🔴 결제 완료 화면이 **스스로와 모순되지 않는가** (2026-08-08, 대표 지적).
 *
 * 무통장 입금 대기 화면이 이랬다:
 * ```
 * 제목      "아직 결제가 완료된 것이 아닙니다"
 * 주 CTA    🔴 「티켓 확인하기」        ← 티켓이 아직 없다
 * 당일 안내  "입장 시 QR 코드를 제시"   ← 발급 전인데 단정한다
 * ```
 * 손님은 그 큰 버튼을 누르고 **빈 목록**을 본다 — 결제가 실패했다고 읽는다.
 */
import { describe, expect, it } from "vitest";
import { dayGuideLines, primaryCta } from "./completion-actions";

describe("🔴 입금 대기 — 지금 할 수 있는 일 하나만 보여준다", () => {
  it("🔴 계좌가 있으면 「입금 계좌 복사」다 — 「티켓 확인하기」가 아니다", () => {
    const cta = primaryCta({ awaitingDeposit: true, ticketNumber: null, hasBankInfo: true });
    expect(cta.kind).toBe("copy-account");
    expect(cta.label).toBe("입금 계좌 복사");
  });

  it("🔴 티켓번호가 어쩌다 있어도 입금 대기면 티켓으로 보내지 않는다", () => {
    // 발급 전인데 번호만 먼저 붙는 경우가 있다. 상태가 우선이다.
    const cta = primaryCta({ awaitingDeposit: true, ticketNumber: "PK-1", hasBankInfo: true });
    expect(cta.kind).toBe("copy-account");
    expect(cta.href, "티켓으로 보내는 링크가 생겼다").toBeUndefined();
  });

  it("계좌 설정이 없으면 복사할 게 없다 — 예약 내역으로", () => {
    const cta = primaryCta({ awaitingDeposit: true, ticketNumber: null, hasBankInfo: false });
    expect(cta).toEqual({ kind: "orders", label: "예약 내역 확인", href: "/my-tickets" });
  });
});

describe("결제 완료 — 티켓으로 보낸다", () => {
  it("티켓번호가 있으면 티켓 화면으로", () => {
    const cta = primaryCta({ awaitingDeposit: false, ticketNumber: "PK-1", hasBankInfo: true });
    expect(cta).toEqual({ kind: "ticket", label: "티켓 확인하기", href: "/tickets/PK-1" });
  });

  it("🔴 티켓번호가 없으면 예약 내역으로 — 없는 티켓을 열러 보내지 않는다", () => {
    const cta = primaryCta({ awaitingDeposit: false, ticketNumber: null, hasBankInfo: true });
    expect(cta.kind).toBe("orders");
    expect(cta.href).toBe("/my-tickets");
  });

  it("빈 문자열·공백 티켓번호도 없는 것으로 본다 — /tickets/ 로 보내면 404 다", () => {
    expect(primaryCta({ awaitingDeposit: false, ticketNumber: "", hasBankInfo: true }).kind).toBe("orders");
    expect(primaryCta({ awaitingDeposit: false, ticketNumber: "   ", hasBankInfo: true }).kind).toBe("orders");
  });

  it("티켓번호를 인코딩한다", () => {
    expect(primaryCta({ awaitingDeposit: false, ticketNumber: "PK 1/2", hasBankInfo: true }).href).toBe(
      "/tickets/PK%201%2F2",
    );
  });
});

describe("🔴 당일 안내 — 없는 QR 을 제시하라고 하지 않는다", () => {
  it("🔴 입금 대기에는 QR 제시 문구가 없다", () => {
    const lines = dayGuideLines(true).join(" ");
    expect(lines, "발급 전인데 QR 을 제시하라고 한다").not.toMatch(/제시/);
    expect(lines).toMatch(/입금이 확인되면/);
  });

  it("입금 대기에도 다음에 무엇을 기다리는지 말한다", () => {
    expect(dayGuideLines(true).some((l) => l.includes("발급"))).toBe(true);
  });

  it("결제 완료에는 종전 안내 그대로", () => {
    const lines = dayGuideLines(false);
    expect(lines[0]).toMatch(/QR 코드를 스태프에게 제시/);
    expect(lines).toHaveLength(3);
  });

  it("🔴 두 문구가 서로 다르다 — 같으면 분기가 죽은 것이다", () => {
    expect(dayGuideLines(true)).not.toEqual(dayGuideLines(false));
  });
});

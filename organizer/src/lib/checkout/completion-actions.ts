/**
 * 결제 완료 화면의 **주 행동**과 **당일 안내 문구**.
 *
 * ## 🔴 왜 함수로 빼는가 (2026-08-08, 대표 지적)
 * 무통장 입금 대기 화면이 **스스로와 모순돼 있었다.**
 * ```
 * 제목      "아직 결제가 완료된 것이 아닙니다"
 * 주 CTA    🔴 「티켓 확인하기」        ← 티켓이 아직 없다
 * 당일 안내  "입장 시 QR 코드를 제시"   ← 발급 전인데 단정한다
 * ```
 * 손님은 그 큰 버튼을 누르고 **빈 목록**을 본다. 상태에 따라 갈리는 판정을 JSX 안에
 * 흩어 놓으면 이렇게 한쪽만 고쳐진다 — 한 곳에서 정하고 화면은 그리기만 한다.
 */

export type CompletionCtaKind = "copy-account" | "ticket" | "orders";

export interface CompletionCta {
  kind: CompletionCtaKind;
  label: string;
  /** `copy-account` 는 이동하지 않는다(그 자리에서 복사). */
  href?: string;
}

export interface CompletionState {
  /** 무통장 입금 대기 — 아직 결제가 안 끝났고 티켓도 없다. */
  awaitingDeposit: boolean;
  ticketNumber: string | null;
  /** 입금 계좌 안내가 실제로 설정돼 있는가. 없으면 복사할 것이 없다. */
  hasBankInfo: boolean;
}

/**
 * 지금 손님이 **할 수 있는 단 하나**를 고른다.
 *
 * ```
 * 입금 대기 + 계좌 있음   입금 계좌 복사   ← 지금 할 일이 그것뿐이다
 * 입금 대기 + 계좌 없음   예약 내역 확인   (복사할 것이 없다)
 * 결제 완료 + 티켓 있음   티켓 확인하기
 * 결제 완료 + 티켓 없음   예약 내역 확인   (발급이 늦어지는 중)
 * ```
 *
 * ⚠️ **입금 대기에 「티켓 확인하기」를 두지 않는다.** 없는 것을 확인하러 보내면
 *    손님은 결제가 실패했다고 읽는다.
 */
export function primaryCta(state: CompletionState): CompletionCta {
  if (state.awaitingDeposit) {
    return state.hasBankInfo
      ? { kind: "copy-account", label: "입금 계좌 복사" }
      : { kind: "orders", label: "예약 내역 확인", href: "/my-tickets" };
  }
  const num = (state.ticketNumber ?? "").trim();
  return num
    ? { kind: "ticket", label: "티켓 확인하기", href: `/tickets/${encodeURIComponent(num)}` }
    : { kind: "orders", label: "예약 내역 확인", href: "/my-tickets" };
}

/**
 * 당일 안내.
 *
 * 🔴 입금 대기에는 **"QR 을 제시하세요"** 라고 쓰지 않는다 — 제시할 QR 이 없다.
 *    발급 조건을 먼저 말해야 손님이 다음에 무엇을 기다리는지 안다.
 */
export function dayGuideLines(awaitingDeposit: boolean): string[] {
  if (awaitingDeposit) {
    return [
      "입금이 확인되면 모바일 티켓이 발급됩니다",
      "발급 후 「내 티켓」에서 QR 코드를 확인하실 수 있습니다",
      "체크인은 이벤트 시작 30분 전부터 가능합니다",
    ];
  }
  return [
    "입장 시 모바일 티켓의 QR 코드를 스태프에게 제시해 주세요",
    "체크인은 이벤트 시작 30분 전부터 가능합니다",
    "분실 시 「내 티켓」 페이지에서 다시 확인할 수 있습니다",
  ];
}

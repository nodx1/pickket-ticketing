/**
 * 트랙 2.8 + 7.12 — 좌석 시스템 PostMessage Bridge
 *
 * ⚠️ 현재 caller 없음 (lib 만 존재). 다음 caller 가 통합 시 활성화:
 *   1. visual-builder.tsx 의 "라이브 미리보기" 토글 → iframe + sendToBridge("seats:reload")
 *   2. /embed/seats/[slug] 페이지 (별도 신규) → listenBridge() 로 부모 native 와 통신
 *
 * 빌더 라이브 미리보기 (iframe) + WebView/모바일 앱 임베드 양쪽에서 사용.
 *
 * 메시지 타입:
 *  - "seats:loaded"      뷰어 → 부모: 좌석맵 로드 완료
 *  - "seats:selected"    뷰어 → 부모: 사용자가 좌석 선택/해제
 *  - "seats:hold"        뷰어 → 부모: hold 결과 (성공/실패)
 *  - "seats:error"       뷰어 → 부모: 에러 발생
 *  - "seats:reload"      부모 → 뷰어: 강제 새로고침 (빌더 변경 알림)
 *  - "seats:focus"       부모 → 뷰어: 특정 좌석 강조
 */

export type SeatBridgeMessage =
  | { type: "seats:loaded"; mapId: string; count: number }
  | { type: "seats:selected"; seatIds: string[] }
  | {
      type: "seats:hold";
      success: boolean;
      holdId?: string;
      holdToken?: string;
      error?: string;
    }
  | { type: "seats:error"; message: string }
  | { type: "seats:reload"; reason?: string }
  | { type: "seats:focus"; seatId: string };

export const SEAT_BRIDGE_NAMESPACE = "pickket-seats-bridge";

interface BridgeEnvelope {
  ns: typeof SEAT_BRIDGE_NAMESPACE;
  payload: SeatBridgeMessage;
}

/**
 * 부모(빌더 또는 native) → 자식 iframe 으로 메시지 전송
 */
export function sendToBridge(
  target: Window,
  message: SeatBridgeMessage,
  targetOrigin = "*",
): void {
  const envelope: BridgeEnvelope = {
    ns: SEAT_BRIDGE_NAMESPACE,
    payload: message,
  };
  target.postMessage(envelope, targetOrigin);
}

/**
 * 부모 또는 자식이 메시지를 수신할 때 사용.
 * 반환된 함수를 호출하면 listener 해제.
 */
export function listenBridge(
  handler: (msg: SeatBridgeMessage, source: Window | null) => void,
): () => void {
  function onMessage(e: MessageEvent) {
    const data = e.data as BridgeEnvelope | undefined;
    if (!data || data.ns !== SEAT_BRIDGE_NAMESPACE) return;
    handler(data.payload, (e.source as Window | null) ?? null);
  }
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

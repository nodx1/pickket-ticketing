/**
 * 메시지 유형(messageType) 서버 강제(배치3 §3-1, 감사 C-03).
 *
 * 기존엔 클라이언트가 messageType(informational/advertising)을 직접 선택해, 마케팅 콘텐츠를
 * informational 로 보내 광고 동의·(광고)표기·야간가드를 우회할 수 있었다.
 * 이제 클라이언트는 "발송 목적(purpose)"만 고르고, 서버가 채널·목적으로 유형을 강제한다.
 * 본문 내용 기반 오버라이드는 불가하다.
 *
 * 판정 규칙:
 *   ① 알림톡 = 정보성 고정(카카오 승인 템플릿 전용, 광고성 금지).
 *   ② 캠페인 = 광고성 고정(캠페인 send 라우트가 message_type='advertising' 로 v2 큐잉).
 *   ③ 메시지 = 목적 매핑(체크인/공지/리마인드=정보성 · 프로모션/판매촉진=광고성).
 */
import type { Channel, MessageType } from "./compliance";

export type MessagePurpose = "checkin" | "notice" | "reminder" | "promotion" | "sale";

export const MESSAGE_PURPOSES: Array<{ value: MessagePurpose; label: string; type: MessageType }> = [
  { value: "checkin", label: "체크인 안내", type: "informational" },
  { value: "notice", label: "공지", type: "informational" },
  { value: "reminder", label: "리마인드", type: "informational" },
  { value: "promotion", label: "프로모션", type: "advertising" },
  { value: "sale", label: "판매촉진", type: "advertising" },
];

const BY_VALUE = new Map(MESSAGE_PURPOSES.map((p) => [p.value, p]));

/**
 * 채널·목적으로 messageType 을 서버 판정하고 근거를 함께 반환(감사 기록용).
 * 알림톡은 목적과 무관하게 정보성 고정. 미지정 목적은 안전하게 정보성으로 폴백하되 근거에 남긴다.
 */
export function deriveMessageType(
  channel: Channel,
  purpose: MessagePurpose | undefined,
): { messageType: MessageType; reason: string } {
  if (channel === "kakao") {
    return { messageType: "informational", reason: "channel=alimtalk→정보성 고정(카카오 규정)" };
  }
  if (!purpose) {
    return { messageType: "informational", reason: "purpose 미지정→정보성 기본" };
  }
  const meta = BY_VALUE.get(purpose);
  if (!meta) {
    return { messageType: "informational", reason: `purpose=${purpose}(미지원)→정보성 기본` };
  }
  return {
    messageType: meta.type,
    reason: `purpose=${purpose}(${meta.label})→${meta.type}`,
  };
}

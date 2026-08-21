/**
 * 피처플래그 — 신규 기능 ON/OFF 제어
 *
 * 1차 런칭: SCHEDULE_TAB, CHAT_FAB = true
 * 백엔드 엔드포인트 준비 후: TODAY_SCHEDULE_HOME, FAN_STAMP 재 ON
 *
 * 추후 Firebase Remote Config 연동 시 서버 사이드 제어 가능
 */
export const FEATURES = {
  // ── 1차 런칭 ON ──
  SCHEDULE_TAB: true,
  CHAT_FAB: true,

  // ── 백엔드 엔드포인트 대기 (Sprint PB-1 완료 후 ON) ──
  // AUDIT 2026-04-20 §22 P0: /schedule/feed, /fan-stamp/*, /users/me/fan-profile 백엔드 미존재
  TODAY_SCHEDULE_HOME: false,
  FAN_STAMP: false,

  // ── 2차 업데이트 (데이터/검증 후 ON) ──
  CHAT_INLINE_BOOKING: false,
  FAN_SCORE_MISSIONS: false,
  FAN_SCORE_LEAGUE: false,
  DAILY_VOTE: false,
  DAILY_QUIZ: false,
  PHOTO_CARDS: false,

  // ── 3차 이후 ──
  MCP_SERVER: false,
  LIVE_WRAPPED: false,
  LIVE_LOG: false,
  OCR_IMPORT: false,
  PHOTO_CARD_TRADING: false,
} as const;

export type FeatureKey = keyof typeof FEATURES;

/** 피처 활성 여부 확인 */
export function isFeatureEnabled(key: FeatureKey): boolean {
  return FEATURES[key];
}

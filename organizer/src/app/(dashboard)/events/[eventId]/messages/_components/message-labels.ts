export const CHANNEL_LABELS: Record<string, string> = {
  email: "이메일",
  sms: "SMS",
  alimtalk: "카카오 알림톡",
};

export const STATUS_LABELS: Record<string, string> = {
  draft: "임시저장",
  scheduled: "예약됨",
  queued: "발송대기",
  sending: "발송중",
  sent: "발송완료",
  delivered: "도달",
  skipped: "제외",
  failed: "실패",
};

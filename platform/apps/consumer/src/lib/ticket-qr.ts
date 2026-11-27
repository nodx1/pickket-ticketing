/**
 * 「내 티켓」 QR 을 언제 새로 받아 올지.
 *
 * 서버가 주는 두 값:
 *  - refresh_in_seconds: 화면이 새 QR 을 받아 올 주기(지금 30초)
 *  - expires_in_seconds: 입구에서 그 QR 을 인정하는 시간(지금 60초)
 * 주기를 따르면 화면에 떠 있는 QR 은 언제 비춰도 유효하다.
 * 옛 서버(주기 없음)는 만료 5초 전에 받는다 — 유효 시간이 5초였을 때 이 계산이 1초 간격이 됐다.
 */
export function ticketQrRefetchMs(
  data: { expires_in_seconds: number; refresh_in_seconds?: number | null } | null | undefined,
): number | false {
  if (!data) return false;
  if (data.refresh_in_seconds && data.refresh_in_seconds > 0) return data.refresh_in_seconds * 1000;
  if (data.expires_in_seconds <= 0) return false;
  return Math.max(1000, (data.expires_in_seconds - 5) * 1000);
}

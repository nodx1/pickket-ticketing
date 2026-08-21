/**
 * 개인화 이름 치환(M-09) — {이름} / {name} / {{name}} 3표기를 한 유틸로 통일.
 * 기존엔 캠페인 경로는 {name} 을, 메시지 경로는 {{name}} 을 못 바꿔 표기가 갈렸다.
 * {{name}} 을 먼저 매칭(정규식 alternation 좌→우)해 중괄호 잔존을 막는다.
 */
export function personalizeName(text: string, name: string | null | undefined): string {
  return text.replace(/\{\{name\}\}|\{이름\}|\{name\}/g, name || "고객");
}

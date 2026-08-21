/**
 * 법정 표시사항 상수/템플릿(배치3 §3-3 · 정보통신망법 제50조·시행령 별표 6).
 *
 * ✅ 문구 내부 확정 2026-07-20(대표). 표시항목·문구 확정본.
 *   ※ 실광고 발송 자체는 여전히 잔여 게이트(NCP/SENS 셋업·실자격증명·DB백업·장애주입 리허설) 후 개시.
 * 값은 env 우선(변경 시 무배포 반영), 미설정 시 확정본 폴백.
 * 발신 이메일: support@pickket.kr 확정(env MAILER_SENDER_ADDRESS 로 오버라이드 가능).
 * SMS 수신거부 번호: 070-8080-5606(대표 지정). ⚠️ 070은 무료회선 아님 → "무료수신거부"로 표기하지 않음
 *   (허위 무료표시 방지). 무료 수단은 이메일 수신거부 링크. SMS 광고 실개시 시 080 착신과금 확보 검토.
 */
const env = (n: string) => process.env[n]?.trim() || undefined;

export const LEGAL = {
  companyName: () => env("NEXT_PUBLIC_COMPANY_NAME") || "주식회사 노드엑스",
  businessNumber: () => env("NEXT_PUBLIC_BUSINESS_NUMBER") || "851-81-04102",
  phone: () => env("NEXT_PUBLIC_CONTACT_PHONE") || "070-8080-5606",
  address: () =>
    env("NEXT_PUBLIC_COMPANY_ADDRESS") ||
    "경기도 고양시 덕양구 청초로 10, 덕은지엘메트로시티한강 A1동 1513호",
  senderEmail: () => env("MAILER_SENDER_ADDRESS") || "support@pickket.kr",
  unsubscribeNumber: () => env("SMS_UNSUBSCRIBE_NUMBER") || "070-8080-5606",
};

/**
 * 광고 이메일 법정 footer(HTML). 시행령 별표6: 전송자 명칭·전화·주소·수신거부(무료).
 * 수신거부 링크 클릭 = 무료 수단이므로 이메일은 "수신거부(무료)" 표기 유지.
 */
export function adEmailFooterHtml(unsubscribeUrl: string): string {
  return (
    `<hr style="margin-top:24px;border:none;border-top:1px solid #eee"/>` +
    `<p style="font-size:12px;color:#888;line-height:1.6">본 메일은 광고성 정보입니다.<br/>` +
    `전송자: ${LEGAL.companyName()} (사업자등록번호 ${LEGAL.businessNumber()})<br/>` +
    `연락처: ${LEGAL.phone()} · ${LEGAL.senderEmail()}<br/>` +
    `주소: ${LEGAL.address()}<br/>` +
    `더 이상 수신을 원치 않으시면 <a href="${unsubscribeUrl}" style="color:#6C5CE7">수신거부</a>(무료)를 눌러주세요.</p>`
  );
}

/**
 * 광고 SMS 법정 표기(평문 접미). 시행령 별표6: 전송자 명칭·연락처·수신거부.
 * ⚠️ 070은 무료회선이 아니므로 "무료수신거부"가 아닌 "수신거부"로만 표기(허위 무료표시 방지).
 *   전송자 연락처와 수신거부 번호가 동일하면 중복 표기하지 않는다.
 */
export function adSmsFooter(): string {
  const num = LEGAL.unsubscribeNumber();
  const phone = LEGAL.phone();
  let out = `\n전송자 ${LEGAL.companyName()} ${phone}`;
  if (num && num !== phone) out += `\n수신거부 ${num}`;
  return out;
}

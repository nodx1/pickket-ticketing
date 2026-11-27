// 직원 입장 링크(/terminal)는 요청마다 그려야 한다.
// 이 화면은 로그인·쿠키를 읽지 않아 빌드 때 정적 HTML 로 미리 만들어지는데, 그러면 요청마다 바뀌는
// CSP nonce 가 인라인 스크립트에 붙지 않아(proxy.ts 의 script-src 는 nonce 만 허용) 운영에서 화면이
// 하얗게 멈춘다(실측 2026-11-27, go.pickket.kr — 개발 서버는 늘 동적이라 드러나지 않았다).
export const dynamic = "force-dynamic";

export default function TerminalLayout({ children }: { children: React.ReactNode }) {
  return children;
}

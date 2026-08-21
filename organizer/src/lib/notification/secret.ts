/**
 * 발송 계열 토큰 시크릿 해석 — fail-close(감사 H-05).
 *
 * 개발 편의를 위한 하드코딩 폴백은 비프로덕션에서만 허용한다. 프로덕션(NODE_ENV=production)에서
 * 전용 시크릿이 없으면 dev 상수로 조용히 서명하지 않고 사용 시점에 throw 한다 —
 * 그렇지 않으면 공격자가 알려진 dev 시크릿으로 수신거부/트래킹 토큰을 위조할 수 있다.
 *
 * ⚠️ tsx 워커에서도 쓰이므로 env.server("server-only") 대신 process.env 직접 참조.
 */
export function resolveNotificationSecret(
  candidateEnvNames: string[],
  devFallback: string,
  label: string,
): string {
  for (const name of candidateEnvNames) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${label} 시크릿이 설정되지 않았습니다(${candidateEnvNames.join("/")}). 프로덕션에서는 전용 고엔트로피 키가 필수입니다.`,
    );
  }
  return devFallback;
}

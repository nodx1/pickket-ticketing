/**
 * 워커(tsx)·Next 서버 양쪽에서 안전한 런타임 env 읽기.
 * env.server 는 `import "server-only"` 라 독립 tsx 워커(scripts/workers/*)에서 resolve 불가.
 * 발송 계층(email/sms/alimtalk/dispatch)은 워커에서도 도므로 이 헬퍼를 쓴다.
 */
export function getRuntimeEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getRuntimeFlag(name: string): boolean {
  const value = getRuntimeEnv(name)?.toLowerCase();
  return value === "true" || value === "1";
}

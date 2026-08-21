/**
 * 외부 링크 href 안전화 — organizer/admin 이 설정하는 URL 필드(broadcast_url 등)가
 * `javascript:`/`data:` 같은 위험 스킴으로 들어오면 XSS/피싱 벡터가 된다.
 * http/https 만 허용하고, 그 외(상대경로 포함)는 null 을 반환해 href 에 넣지 않는다.
 */
export function safeExternalUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    return null;
  } catch {
    // 절대 URL 로 파싱 안 되면(상대경로/스킴없음) 외부링크로 신뢰하지 않음
    return null;
  }
}

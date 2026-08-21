/**
 * 토스 결제 WebView 순수 헬퍼 — 스킴 인터셉트·PG 호스트 검증·콜백 파싱.
 * (payment.tsx onShouldStartLoadWithRequest / handlePaymentCallback 에서 사용)
 */

export function matchesScheme(url: string, scheme: string): boolean {
  return url === scheme || url.startsWith(scheme + "?") || url.startsWith(scheme + "#");
}

/** http(s) 외 스킴(카드사/은행/간편결제 앱: supertoss://·ispmobile://·intent:// 등) → 외부앱 실행 대상. */
export function isExternalAppScheme(url: string): boolean {
  return !url.startsWith("http://") && !url.startsWith("https://");
}

/** PG 리다이렉트 허용 호스트(정확 일치 또는 서브도메인)인지. 파싱 실패 시 false. */
export function isAllowedPgHost(url: string, allowed: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname;
    return allowed.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

export interface PaymentCallback {
  kind: "success" | "fail" | "none";
  pgTransactionId?: string;
  pgProvider?: string;
  paymentId?: string;
  reason?: string;
}

/** pickket:// 콜백 URL 파싱 → 성공/실패/무관 + 결제 식별자. */
export function parsePaymentCallback(
  url: string,
  successScheme: string,
  failScheme: string,
): PaymentCallback {
  if (matchesScheme(url, successScheme)) {
    const q = new URL(url.replace("pickket://", "https://placeholder/")).searchParams;
    return {
      kind: "success",
      pgTransactionId: q.get("pg_transaction_id") ?? "",
      pgProvider: q.get("pg_provider") ?? "toss",
      paymentId: q.get("payment_id") ?? undefined,
    };
  }
  if (matchesScheme(url, failScheme)) {
    const q = new URL(url.replace("pickket://", "https://placeholder/")).searchParams;
    return { kind: "fail", reason: q.get("reason") ?? undefined };
  }
  return { kind: "none" };
}

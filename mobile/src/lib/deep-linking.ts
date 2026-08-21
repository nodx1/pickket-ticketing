/**
 * 딥링크 유틸리티
 * Custom scheme (pickket://) + Universal Links (https://pickket.kr) 처리
 */
import * as Linking from "expo-linking";
import { router } from "expo-router";

/**
 * URL에서 앱 내부 라우트로 변환
 * - pickket://event/123 → /event/123
 * - pickket://e/slug → /e/slug
 * - https://pickket.kr/events/123 → /event/123
 * - https://pickket.kr/e/slug → /e/slug
 * - https://pickket.kr/ko/events/123 → /event/123
 * - https://pickket.kr/tickets/123 → /ticket/123
 * - https://pickket.kr/orders/123 → /order/123
 */
/** 허용된 유니버설 링크 호스트 */
const TRUSTED_HOSTS = new Set([
  "pickket.kr",
  "www.pickket.kr",
  "stg.pickket.kr",
]);

export function parseDeepLink(url: string): string | null {
  try {
    const parsed = Linking.parse(url);
    const path = parsed.path ?? "";

    // Custom scheme: pickket://event/123
    if (parsed.scheme === "pickket") {
      if (path === "payment/success" || path === "payment/fail") return null;
      // AUDIT §1 P1: 커스텀 스킴도 ID 검증
      const safeRoute = /^(event|e|ticket|order)\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
      if (safeRoute) return `/${safeRoute[1]}/${safeRoute[2]}`;
      return null;
    }

    // Universal Links: https://pickket.kr/[locale]/events/123
    // HTTP 스킴 거부 — MITM 다운그레이드 공격 차단(P2-C26). HTTPS만 허용.
    if (parsed.scheme === "https") {
      const host = parsed.hostname?.toLowerCase();
      if (!host || !TRUSTED_HOSTS.has(host)) return null;
    } else {
      // https/pickket:// 이외의 스킴은 모두 거부
      return null;
    }

    // Strip locale prefix if present (ko, en, ja, etc.)
    const segments = path.split("/").filter(Boolean);
    const localePattern = /^(ko|en|ja|zh-CN|vi|fr|ru)$/;

    let idx = 0;
    if (segments.length > 0 && localePattern.test(segments[0])) {
      idx = 1; // skip locale
    }

    const resource = segments[idx];
    const id = segments[idx + 1];

    if (!resource || !id) return null;

    // AUDIT §1 P1: ID 형식 검증 — path traversal/injection 방지
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;

    switch (resource) {
      case "events":
        return `/event/${id}`;
      case "e":
        return `/e/${id}`;
      case "tickets":
        return `/ticket/${id}`;
      case "orders":
        return `/order/${id}`;
      default:
        return null;
    }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    return null;
  }
}

/**
 * 딥링크 처리 — 앱 내부 라우트로 이동
 */
export function handleDeepLink(url: string): boolean {
  const route = parseDeepLink(url);
  if (!route) return false;

  router.push(route as never);
  return true;
}

/**
 * 초기 URL 확인 (앱이 딥링크로 열린 경우)
 */
export async function getInitialDeepLink(): Promise<string | null> {
  const url = await Linking.getInitialURL();
  if (!url) return null;
  return parseDeepLink(url);
}

/**
 * 딥링크 이벤트 리스너 등록
 * 앱이 이미 열려있는 상태에서 딥링크를 받은 경우
 */
export function addDeepLinkListener(callback: (route: string) => void) {
  return Linking.addEventListener("url", (event) => {
    const route = parseDeepLink(event.url);
    if (route) callback(route);
  });
}

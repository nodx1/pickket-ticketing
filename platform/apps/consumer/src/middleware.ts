/**
 * Next.js 16 proxy — combines:
 * 1. Subdomain detection & rewriting ({slug}.pickket.kr → /s/{slug}/...)
 * 2. next-intl locale routing
 * 3. Security headers (CSP, nonce, widget iframe support)
 * 4. Legacy redirects
 */

import { NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { API_URL } from "@pickket/lib";
import { routing } from "./i18n/routing";

/* ────────────────────── Config ────────────────────── */

const MAIN_HOSTS = new Set([
  "www.pickket.kr",
  "pickket.kr",
  "localhost",
  "127.0.0.1",
]);

/** Reserved subdomains that should NOT be treated as event slugs. */
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "go",
  "staging",
  "cdn",
  "assets",
  "mail",
  "status",
]);

const REDIRECTS: Record<string, string> = {
  "/login": "/auth",
  "/register": "/auth",
  "/signup": "/auth",
  "/signin": "/auth",
  "/why-now": "/about",
  "/introduction": "/about",
};

const intlMiddleware = createIntlMiddleware(routing);
const REFRESH_COOKIE_NAMES = [
  "__Host-pickket_refresh",
  "pickket_refresh",
  "pickket_logged_in",
];

/* ────────────────────── CSP ────────────────────── */

function buildCspHeader(
  nonce: string,
  apiOrigin: string,
  cdnUrl: string,
  isDev: boolean,
  isWidget: boolean = false,
): string {
  // SSOT = NEXT_PUBLIC_GO_URL (@pickket/lib GO_URL 과 동일 변수). 미설정 시 connect-src
  // 에서 go origin 누락 → consumer→go fetch 가 CSP 로 차단되므로 변수명 통일 필수.
  const pickketGoUrl = process.env.NEXT_PUBLIC_GO_URL;
  const connectSrc = [
    "'self'",
    "https://*.sentry.io",
    // 토스페이먼츠 V2 SDK 가 requestPayment() 중 api.tosspayments.com 을 호출한다.
    "https://api.tosspayments.com",
    apiOrigin,
    ...(pickketGoUrl ? [pickketGoUrl] : []),
    ...(cdnUrl ? [cdnUrl] : []),
    ...(isDev ? ["ws:", "wss:"] : []),
  ].join(" ");
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "https://static.cloudflareinsights.com",
    "https://js.tosspayments.com",
    // 나이스페이 구형 결제창 SDK(nicepay-pgweb.js) 로드 도메인.
    // js_url = https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js (nice.ts / VERIFIED-SPEC §2).
    "https://pg-web.nicepay.co.kr",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    // 'unsafe-inline' required: Next.js injects inline <style> for font-face,
    // layout shift prevention, and styled-jsx. Removing breaks rendering.
    "style-src-elem 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${cdnUrl || "https:"} https://*.pickket.kr https://pickket.kr`,
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    // 토스 결제창은 successUrl 로 전체 페이지 리다이렉트하지만, 카드사 인증 iframe 등을
    // 위해 토스 도메인을 허용한다. open.spotify.com: 아티스트 플레이리스트 임베드.
    // 나이스 구형 goPay 는 결제창(pg-web)·카드사 인증을 나이스 도메인에서 렌더하므로
    // frame-src/child-src 에 *.nicepay.co.kr(pg-web·dc1/dc2-api) 을 허용한다.
    // www.openstreetmap.org: 이벤트 장소 지도(임베드). 지도 API 연동(과업지시서 2-1).
    "frame-src 'self' https://*.tosspayments.com https://open.spotify.com https://*.nicepay.co.kr https://www.openstreetmap.org",
    "child-src 'self' https://*.nicepay.co.kr",
    "object-src 'none'",
    "base-uri 'self'",
    isWidget
      ? "frame-ancestors https://*.pickket.kr https://pickket.kr"
      : "frame-ancestors 'none'",
    // 나이스 구형 goPay 는 payForm 을 나이스 결제창(pg-web)/인증(dc1·dc2-api)으로 POST 하므로
    // form-action 에 *.nicepay.co.kr 을 허용한다(토스/self 유지). 승인 API(dc1/dc2·webapi)는
    // v2 backend 의 서버간 호출이라 connect-src 불필요.
    "form-action 'self' https://*.nicepay.co.kr",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function attachSecurityHeaders(
  response: NextResponse,
  nonce: string,
  csp: string,
) {
  response.headers.set("Content-Security-Policy", csp);
  // SECURITY: nonce must NOT be exposed in a response header — client JS could
  // read it and bypass CSP. It is passed only as a REQUEST header (see below).
  return response;
}

/**
 * CDN 캐시 헤더 설정 — Next.js 미들웨어가 자동으로 Cache-Control: private를
 * 설정하므로, CDN-Cache-Control로 Cloudflare 엣지 캐시를 별도 지시.
 * 브라우저에는 private이 유지되어 stale HTML을 보여주지 않음.
 */
const CDN_CACHE_RULES: Array<{ match: RegExp; maxAge: number }> = [
  // 이벤트 상세 — ISR 30s
  { match: /^\/([a-z]{2}(-[A-Z]+)?\/)?events\/[^/]+$/, maxAge: 30 },
  // 이벤트 목록 — ISR 60s
  { match: /^\/([a-z]{2}(-[A-Z]+)?\/)?events\/?$/, maxAge: 60 },
  // 서브도메인 — 60s
  { match: /^\/s\//, maxAge: 60 },
  // 기타 페이지 (홈, 정적 페이지) — ISR 300s
  { match: /^\//, maxAge: 300 },
];

function attachCdnCacheHeaders(
  response: NextResponse,
  pathname: string,
  isAuthenticated: boolean,
) {
  // 인증 유저, 리다이렉트, API 요청은 캐시하지 않음
  const status = response.status;
  if (isAuthenticated || status >= 300 || pathname.startsWith("/api")) {
    return response;
  }
  // 보호 라우트는 캐시하지 않음
  if (PROTECTED_PREFIXES.some((p) => pathname.includes(p))) {
    return response;
  }

  for (const rule of CDN_CACHE_RULES) {
    if (rule.match.test(pathname)) {
      response.headers.set(
        "CDN-Cache-Control",
        `public, max-age=${rule.maxAge}, stale-while-revalidate=${rule.maxAge * 2}`,
      );
      break;
    }
  }
  return response;
}

/* ────────────────── Subdomain detection ────────────────── */

function extractSubdomain(host: string): string | null {
  // Remove port
  const hostname = host.split(":")[0];

  // Skip main hosts
  if (MAIN_HOSTS.has(hostname)) return null;

  // Dev: support {slug}.localhost pattern
  if (hostname.endsWith(".localhost")) {
    const sub = hostname.replace(".localhost", "");
    if (sub && !RESERVED_SUBDOMAINS.has(sub)) return sub;
    return null;
  }

  // Production: {slug}.pickket.kr
  const match = hostname.match(
    /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.pickket\.kr$/,
  );
  if (match) {
    const sub = match[1];
    if (!RESERVED_SUBDOMAINS.has(sub)) return sub;
  }

  return null;
}

/* ────────────────── Auth-protected routes ────────────────── */

const PROTECTED_PREFIXES = ["/mypage", "/orders", "/tickets", "/settings"];

function hasRefreshSession(request: NextRequest): boolean {
  return REFRESH_COOKIE_NAMES.some((cookieName) =>
    request.cookies.has(cookieName),
  );
}

/* ───────────────────── Main proxy ──────────────────── */

export function middleware(request: NextRequest) {
  // SECURITY: per-request random nonce (matches admin middleware).
  // A deployment-static nonce (btoa(NEXT_DEPLOYMENT_ID)) is predictable and
  // reusable, defeating the purpose of a CSP nonce. A unique nonce per request
  // is the correct XSS mitigation.
  //
  // CDN trade-off: pages relying on this nonce in inline scripts become
  // per-request unique and therefore uncacheable. That is acceptable — CDN
  // caching for public HTML is handled separately (see CDN_CACHE_RULES /
  // attachCdnCacheHeaders, which only caches unauthenticated 2xx responses),
  // and correctness of the security boundary takes precedence over cache hit rate.
  const nonce = btoa(crypto.randomUUID()).replace(/=+$/g, "");
  const isDev = process.env.NODE_ENV !== "production";
  const apiOrigin = API_URL;
  const cdnUrl = process.env.CDN_URL || "";

  const { pathname } = request.nextUrl;

  // Skip _next paths (HMR, static assets) — should not reach here but safety net
  if (pathname.startsWith("/_next")) {
    return NextResponse.next();
  }

  // Block dotfile paths (/.env, /.git, etc.) — except /.well-known
  if (pathname.startsWith("/.") && !pathname.startsWith("/.well-known")) {
    return new NextResponse(null, { status: 404 });
  }

  const isWidget = pathname.startsWith("/widget");
  const csp = buildCspHeader(nonce, apiOrigin, cdnUrl, isDev, isWidget);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // ─── 1. Subdomain rewrite ───
  const host = request.headers.get("host") || "";
  const subdomain = extractSubdomain(host);

  const isAuthenticated = hasRefreshSession(request);

  // ─── 1a. Protected route guard (BEFORE subdomain rewrite to prevent auth bypass) ───
  // Check both original pathname and would-be rewritten pathname for auth requirements.
  const localePattern = /^\/(ko|en|ja|zh-CN|fr|ru|vi)(\/|$)/;
  const localeMatch = pathname.match(localePattern);
  const pathWithoutLocale = localeMatch
    ? pathname.replace(localePattern, "/")
    : pathname;

  // /events/[id]/edit — organizer-only; backend enforces auth too, but middleware
  // prevents SSR of the edit form skeleton for unauthenticated requests (bots/crawlers).
  const EVENT_EDIT_RE = /\/events\/[^/]+\/edit(\/|$)/;
  const isProtected =
    PROTECTED_PREFIXES.some(
      (p) => pathWithoutLocale.startsWith(p) || pathname.startsWith(p),
    ) ||
    EVENT_EDIT_RE.test(pathWithoutLocale) ||
    EVENT_EDIT_RE.test(pathname);
  if (isProtected && !isAuthenticated) {
    const url = request.nextUrl.clone();
    url.pathname = localeMatch ? `/${localeMatch[1]}/auth` : "/auth";
    // returnUrl carries the raw request pathname; it is sanitized downstream by
    // resolveAuthReturnUrl (rejects absolute/external URLs, allows only same-origin
    // relative paths) before any redirect is performed. Safe to pass raw here.
    url.searchParams.set("returnUrl", pathname);
    return attachSecurityHeaders(NextResponse.redirect(url), nonce, csp);
  }

  // ─── 1b. Subdomain rewrite ───
  if (subdomain) {
    // Rewrite: bts-concert.pickket.kr/tickets → /s/bts-concert/tickets
    // The URL in the browser stays as bts-concert.pickket.kr/tickets
    const url = request.nextUrl.clone();
    url.pathname = `/s/${subdomain}${pathname}`;
    const response = NextResponse.rewrite(url, { headers: requestHeaders });
    attachSecurityHeaders(response, nonce, csp);
    return attachCdnCacheHeaders(response, pathname, isAuthenticated);
  }

  // ─── 2. Legacy redirects ───
  const target = REDIRECTS[pathWithoutLocale] || REDIRECTS[pathname];
  if (target) {
    const url = request.nextUrl.clone();
    url.pathname = localeMatch ? `/${localeMatch[1]}${target}` : target;
    return attachSecurityHeaders(NextResponse.redirect(url, 301), nonce, csp);
  }

  // ─── 4. next-intl locale routing ───
  const localizedRequest = new NextRequest(request.url, {
    headers: requestHeaders,
    method: request.method,
  });
  const response = intlMiddleware(localizedRequest);
  attachSecurityHeaders(response, nonce, csp);
  return attachCdnCacheHeaders(response, pathname, isAuthenticated);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)", "/(\\..*)"],
};

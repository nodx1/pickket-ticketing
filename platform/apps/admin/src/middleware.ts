import { NextResponse, type NextRequest } from "next/server";
import { API_URL } from "@pickket/lib";

function buildCspHeader(
  nonce: string,
  apiOrigin: string,
  isDev: boolean,
): string {
  const mcpOrigin =
    process.env.NEXT_PUBLIC_MCP_URL || "https://mcp-staging.pickket.kr";
  const connectSrc = [
    "'self'",
    apiOrigin,
    mcpOrigin,
    ...(isDev ? ["ws:", "wss:"] : []),
  ].join(" ");
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "style-src-elem 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.pickket.kr https://*.r2.dev https://*.amazonaws.com https://*.cloudfront.net",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

const AUTH_COOKIE_NAMES = [
  "__Host-pickket_refresh",
  "pickket_refresh",
  "pickket_logged_in",
];

function hasSession(request: NextRequest): boolean {
  return AUTH_COOKIE_NAMES.some((name) => request.cookies.has(name));
}

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID()).replace(/=+$/g, "");
  const isDev = process.env.NODE_ENV !== "production";
  const apiOrigin = API_URL;
  const csp = buildCspHeader(nonce, apiOrigin, isDev);

  const { pathname } = request.nextUrl;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  // /auth 페이지와 정적 에셋 제외 모든 경로 보호
  const isPublic =
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon");

  if (!isPublic && !hasSession(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth";
    url.searchParams.set("callbackUrl", pathname);
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

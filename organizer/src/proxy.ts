import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isProdRuntime } from "@/lib/env/runtime";
import { isUnproxiedInternalPath, rateLimitKey } from "@/lib/request-ip";

/**
 * 전역 API 레이트리밋 — **공인 IP 하나당 1분 한도**.
 *
 * ## 🔴 왜 60 에서 올렸나 (2026-07-31 실측)
 * 키가 **IP 뿐**이라(`rateLimitKey` → `resolveClientIp`) **같은 네트워크의 모든 사람이
 * 한 버킷을 공유**한다. 실제로 배포세션과 대표가 동시에 대시보드를 보다 서로의 한도를
 * 깎았다 — 내 43번째 호출에서 429 가 났고 나머지 17회는 상대가 쓴 것이었다.
 *
 * 대시보드는 화면 하나당 **평균 9회**를 부른다(레이아웃의 auth/me·알림 2종 + 데이터).
 * 60 이면 **혼자서도 1분에 6~7화면**이면 막힌다 — 관리자 화면을 훑는 속도로 충분히 닿는다.
 *
 * 🔴 대회 현장이 더 위험하다: 체크인 스태프 여러 명이 **같은 와이파이**를 쓰면 60을
 * 나눠 쓴다. 체크인은 스캔마다 API 를 부르므로 입장 피크에 줄이 설 수 있다.
 * (이건 계산이고 실측이 아니다 — 현장 인원·회선 구성은 확인 못 했다)
 *
 * ## 올려도 안전한 이유
 * 이건 **거친 그물**이고 민감 경로는 각자 자기 한도를 갖는다(`withRateLimit`):
 *   로그인 5/분 · 공개환불 5/분 · 결제확정 10/분 · 체크아웃 10/분 · MFA 10/분 · 업로드 20/시간
 * 전역을 올려도 그 한도들은 그대로다.
 *
 * ⚠️ **근본 해법이 아니다.** 인증된 요청은 IP 가 아니라 **계정 기준**이어야 한다.
 *    proxy 에서 세션을 읽어야 해 변경 폭이 크므로 대회 후로 미룬다.
 */
const GLOBAL_API_RATE_LIMIT = 600;
import { checkRateLimit } from "@/lib/rate-limit";
import { getOrCreateRequestId } from "@/lib/request-context";

/**
 * per-request nonce 기반 CSP (consumer/admin middleware 와 동일 보안 패턴).
 * script-src 에서 'unsafe-inline' 제거 → nonce 만 허용(XSS 완화). WebAssembly(PixiJS/
 * opencv.js/tfjs)용 'unsafe-eval'/'wasm-unsafe-eval' 와 결제/Sentry 외부 도메인 allowlist 는 유지.
 * style-src 'unsafe-inline' 는 Tailwind/shadcn 인라인 스타일 요구로 유지(consumer 수준).
 */
export function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    // 나이스 구형 결제창 SDK(nicepay-pgweb.js)는 https://pg-web.nicepay.co.kr 에서 로드된다
    // (nice-client.ts js_url / VERIFIED-SPEC §2). 토스/Sentry allowlist 유지.
    `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' https://js.tosspayments.com https://pg-web.nicepay.co.kr https://browser.sentry-cdn.com https://*.sentry.io`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: https://picsum.photos https://*.pickket.kr https://pickket-assets.s3.ap-northeast-2.amazonaws.com",
    "font-src 'self' data:",
    "connect-src 'self' https://*.pickket.kr https://api.tosspayments.com https://*.sentry.io https://pickket-assets.s3.ap-northeast-2.amazonaws.com wss://*.pickket.kr ws://localhost:* http://localhost:*",
    // 나이스 구형 goPay 는 결제창(pg-web)·카드사 인증을 나이스 도메인 프레임에서 렌더한다.
    // www.openstreetmap.org: 「장소 찾기」·장소 지도 임베드(지도 API 연동, 과업지시서 2-1).
    "frame-src 'self' https://pay.toss.im https://*.nicepay.co.kr https://www.openstreetmap.org",
    "child-src 'self' https://*.nicepay.co.kr",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    // 나이스 goPay 는 payForm 을 나이스 결제창/인증(pg-web·dc1/dc2-api)으로 POST 한다.
    // 승인·거래조회(webapi/dc1/dc2)는 v2 backend 서버간 호출이라 connect-src 불필요.
    //
    // 🔴 `https://*.pickket.kr` 가 반드시 있어야 한다 (2026-08-10 실장애).
    //    인증이 끝나면 SDK 가 `nicepaySubmit()` 으로 payForm 을 **ReturnURL 로 POST** 하는데,
    //    그 주소가 `https://api.pickket.kr/api/v1/payments/nice/return`(v2) 다 — `'self'`
    //    (go.pickket.kr)가 아니다. 빠져 있으면 브라우저가 폼 전송을 **차단**하고,
    //    SDK 의 하드콜이 그 자리에서 죽어 오버레이("Please, wait...")가 영원히 남는다.
    //    ⚠️ 데스크탑만 터진다 — 모바일은 리다이렉트라 우리 페이지가 POST 하지 않는다.
    //    ⚠️ connect-src 에는 이미 있었다. **폼 전송은 별도 지시어**라 따라오지 않는다.
    "form-action 'self' https://*.pickket.kr https://pay.toss.im https://*.nicepay.co.kr",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function applySecurityHeaders(response: NextResponse, pathname?: string, csp?: string) {
  // /embed 경로는 iframe 임베드용 — frame-ancestors 는 next.config.ts 의 /embed 헤더가
  // 관리하므로 여기서 CSP 를 설정하지 않고 X-Frame-Options 만 제거.
  if (pathname?.startsWith("/embed")) {
    response.headers.delete("X-Frame-Options");
    return response;
  }
  // 나머지 보안 헤더(X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  // Permissions-Policy, HSTS)는 next.config.ts 의 GLOBAL_SECURITY_HEADERS 에서 관리.
  // CSP 만 per-request nonce 를 위해 여기(proxy)가 SoT — next.config 의 정적 CSP 는 제거됨.
  if (csp) {
    response.headers.set("Content-Security-Policy", csp);
  }
  return response;
}

function applyRequestId(response: NextResponse, requestId: string) {
  response.headers.set("X-Request-Id", requestId);
  return response;
}

function applyCorsHeaders(request: NextRequest, response: NextResponse) {
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    return response;
  }

  const origin = request.headers.get("origin") ?? "";
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3003")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  // 로컬 개발: consumer(:3020)·go(:3000) 크로스오리진 허용(prod 미포함).
  //   ※ 미들웨어가 모든 /api OPTIONS 를 선점하므로 라우트별 CORS 보다 여기서 허용해야 효과 발생.
  if (process.env.NODE_ENV !== "production") {
    allowedOrigins.push("http://localhost:3020", "http://127.0.0.1:3020", "http://localhost:3000");
  }
  const fallbackOrigin = allowedOrigins[0] ?? "http://localhost:3003";

  if (allowedOrigins.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin || fallbackOrigin);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }

  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  const requestId = getOrCreateRequestId(request.headers);
  requestHeaders.set("x-request-id", requestId);

  // per-request nonce CSP. Next.js 가 CSP 헤더의 nonce 를 자기 인라인 스크립트에
  // 자동 적용하도록 요청 헤더에도 CSP/x-nonce 를 전달한다(consumer/admin 과 동일).
  const nonce = btoa(crypto.randomUUID()).replace(/=+$/g, "");
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  if (pathname.startsWith("/api/") && request.method === "OPTIONS") {
    return applyRequestId(
      applyCorsHeaders(request, applySecurityHeaders(new NextResponse(null, { status: 204 }), pathname, csp)),
      requestId,
    );
  }

  if (pathname.startsWith("/api/")) {
    // E2E 테스트(PLAYWRIGHT_TEST=1, 비-exact)는 전역 리미터도 **완전 우회**한다.
    //
    // 🔴 종전엔 여기만 `×10`(600/min)이었고 라우트 리미터(`withRateLimit`)는 완전 우회라
    //    두 계층이 비대칭이었다. 이 ×10 이 보안상 벌어주는 건 없다 — 같은 플래그로 라우트
    //    리미터가 이미 꺼져 있어서다. 반면 workers=N 이 단일 키(`anonymous`)를 공유하면
    //    이쪽만 남아 429 를 뿜는다. 그래서 조건을 `withRateLimit` 과 **같게** 맞춘다.
    //
    // `PLAYWRIGHT_TEST_RATE_LIMIT="enabled"` 면 두 계층이 함께 되살아난다 — 실한도를 보는
    // `phase5-rate-limit.spec.ts` 가 정확히 같은 조건으로 skip/실행되므로 커버리지 손실 없음.
    // prod 는 `PLAYWRIGHT_TEST` 미설정 → 영향 0.
    const bypassRateLimit =
      process.env.PLAYWRIGHT_TEST === "1" &&
      process.env.PLAYWRIGHT_TEST_RATE_LIMIT !== "enabled";
    // 🔴 CF 를 거치지 않는 내부 경로는 IP 게이트에서 제외한다 — v2 가 도커 내부망으로
    //    호출하므로(GO_INTERNAL_BASE_URL) 프록시 헤더가 없다. 근거는 lib/request-ip.ts.
    if (!bypassRateLimit && !isUnproxiedInternalPath(pathname)) {
      const key = rateLimitKey(request.headers, isProdRuntime());
      if (key === null) {
        // 프로덕션에서 IP 를 해석할 수 없다 = 인프라 오설정 또는 CF 우회 직접접속.
        // 종전엔 "anonymous" 로 뭉개 전원이 한 버킷을 공유했다.
        logger.error("[proxy] 클라이언트 IP 해석 실패 — 요청 거부", { pathname });
        return applyRequestId(
          applyCorsHeaders(
            request,
            applySecurityHeaders(
              NextResponse.json({ success: false, error: ERR.SERVER }, { status: 503 }),
              pathname,
              csp,
            ),
          ),
          requestId,
        );
      }
      const result = await checkRateLimit(key, { max: GLOBAL_API_RATE_LIMIT, windowMs: 60_000 });

      if (!result.success) {
        return applyRequestId(
          applyCorsHeaders(
            request,
            applySecurityHeaders(
              NextResponse.json(
                {
                  success: false,
                  error: ERR.RATE_LIMIT,
                },
                {
                  status: 429,
                  headers: {
                    "Retry-After": String(Math.ceil((result.resetAt - Date.now()) / 1000)),
                    "X-RateLimit-Limit": String(GLOBAL_API_RATE_LIMIT),
                    "X-RateLimit-Remaining": "0",
                  },
                },
              ),
              pathname,
              csp,
            ),
          ),
          requestId,
        );
      }
    }
  }

  if (pathname.startsWith("/dashboard")) {
    const session =
      request.cookies.get("pickket_access")?.value ??
      request.cookies.get("pickket_session")?.value;
    if (!session) {
      return applyRequestId(
        applySecurityHeaders(NextResponse.redirect(new URL("/login", request.url)), pathname, csp),
        requestId,
      );
    }
  }

  if (pathname.startsWith("/admin")) {
    const session =
      request.cookies.get("pickket_access")?.value ??
      request.cookies.get("pickket_session")?.value;
    if (!session) {
      return applyRequestId(
        applySecurityHeaders(NextResponse.redirect(new URL("/login", request.url)), pathname, csp),
        requestId,
      );
    }
  }

  return applyRequestId(
    applyCorsHeaders(
      request,
      applySecurityHeaders(
        NextResponse.next({
          request: {
            headers: requestHeaders,
          },
        }),
        pathname,
        csp,
      ),
    ),
    requestId,
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts|uploads).*)"],
};

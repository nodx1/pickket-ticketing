import { NextResponse } from "next/server";
import { ERR } from "@/lib/errors";
import { isProdRuntime } from "@/lib/env/runtime";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKey } from "@/lib/request-ip";
import { getRequestContext } from "@/lib/request-context";

interface RateLimitConfig {
  windowMs?: number;
  max?: number;
  keyPrefix?: string;
}

/**
 * 🔴 종전 구현은 `xff.split(",")[0]` — **클라이언트가 보낸 값**이라 프리픽스를 바꾸면
 *    요청마다 새 버킷이 생겨 한도가 무한이었다. 폴백 `"unknown"` 은 반대로 전원을
 *    한 버킷에 합쳤다. 정본 유도로 대체했다(근거: lib/request-ip.ts).
 */

type RouteHandler<TRequest extends Request = Request, TArgs extends unknown[] = unknown[]> = (
  request: TRequest,
  ...args: TArgs
) => Promise<Response>;

function getTestMultiplier() {
  const isPlaywrightTest = process.env.PLAYWRIGHT_TEST === "1";
  const enableExactLimit = process.env.PLAYWRIGHT_TEST_RATE_LIMIT === "enabled";
  if (isPlaywrightTest && !enableExactLimit) return 10;
  // 로컬 dev 환경에서도 cron + 다중 탭으로 쉽게 초과되므로 10배 확대
  if (process.env.NODE_ENV === "development") return 10;
  return 1;
}

export function withRateLimit(config: RateLimitConfig = {}) {
  const windowMs = config.windowMs ?? 60_000;
  const max = config.max ?? 60;
  const keyPrefix = config.keyPrefix ?? "global";

  return function <TRequest extends Request, TArgs extends unknown[]>(
    handler: RouteHandler<TRequest, TArgs>,
  ): RouteHandler<TRequest, TArgs> {
    return async (request: TRequest, ...args: TArgs) => {
      // E2E 테스트(PLAYWRIGHT_TEST=1, 비-exact)는 레이트리밋 **완전 우회**.
      //   workers=N 동시 실행이 단일 IP(테스트러너)에서 로그인 등을 버스트 → quota*10 으로도 429 발생.
      //   PLAYWRIGHT_TEST_RATE_LIMIT="enabled" 일 때만 실제 한도 적용(rate-limit 전용 테스트).
      //   prod 는 PLAYWRIGHT_TEST 미설정 → 영향 0.
      if (process.env.PLAYWRIGHT_TEST === "1" && process.env.PLAYWRIGHT_TEST_RATE_LIMIT !== "enabled") {
        return handler(request, ...args);
      }
      const ip = rateLimitKey(request.headers, isProdRuntime());
      if (ip === null) {
        return NextResponse.json(
          { success: false, error: ERR.SERVER },
          { status: 503, headers: { "X-Request-Id": getRequestContext(request).requestId } },
        );
      }
      const key = `${keyPrefix}:${ip}`;
      // 테스트 환경: quota 10배 확대 (완전 비활성화 아님)
      const effectiveMax = max * getTestMultiplier();
      const result = await checkRateLimit(key, { windowMs, max: effectiveMax });

      if (!result.success) {
        // 🔴 **얼마나 기다려야 하는지**를 문구에 담는다 (2026-08-01 오픈일).
        //    종전엔 "잠시 후 다시 시도해주세요" 뿐이라, 막힌 사용자가 5초 뒤에 또 누르고
        //    또 막혔다. 대기 시간을 모르면 이탈한다 — 오픈 첫날 가입이 그렇게 막혔다.
        //    ⚠️ 키가 **IP 뿐**이라 모바일 통신사 NAT·공용 와이파이에서는 **남의 시도가
        //       내 한도를 먹는다.** 본인은 처음 눌렀는데 막히는 경우가 실제로 있다.
        const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
        return NextResponse.json(
          {
            success: false,
            error: `${ERR.RATE_LIMIT} (약 ${retryAfterSec}초 후 가능합니다).`,
          },
          {
            status: 429,
            headers: {
              "X-Request-Id": getRequestContext(request).requestId,
              "Retry-After": String(retryAfterSec),
              "X-RateLimit-Limit": String(max),
              "X-RateLimit-Remaining": "0",
            },
          },
        );
      }

      return handler(request, ...args);
    };
  };
}

/**
 * 트랙 7.1 — 좌석 시스템 신규 API 용 rate limit preset.
 * 라우트에서 `withRateLimit(SEAT_RATE_LIMITS.hold)(handler)` 형태로 사용.
 */
export const SEAT_RATE_LIMITS = {
  /** GET /seats — 60/min */
  read: { windowMs: 60_000, max: 60, keyPrefix: "seats:read" },
  /** POST/DELETE /seats/hold — 30/min (집중 호출 방어) */
  hold: { windowMs: 60_000, max: 30, keyPrefix: "seats:hold" },
  /** GET /seats/best-available — 10/min */
  bestAvailable: { windowMs: 60_000, max: 10, keyPrefix: "seats:best" },
  /** POST companion (친구 함께 예매, 1.8) — 10/min */
  companion: { windowMs: 60_000, max: 10, keyPrefix: "seats:companion" },
  /** seat watch (즐겨찾기/가격 알림, 1.9) — 20/min */
  watch: { windowMs: 60_000, max: 20, keyPrefix: "seats:watch" },
  /** CAD 임포트 (트랙 5) — 3/min (대용량 파싱) */
  importCad: { windowMs: 60_000, max: 3, keyPrefix: "seats:import" },
  /** 빌더 협업 SSE/REST (트랙 2.16) — 60/min */
  collab: { windowMs: 60_000, max: 60, keyPrefix: "seats:collab" },
} as const;

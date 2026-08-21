/**
 * v2 auth endpoint 프록시 헬퍼.
 *
 * 작업 2~3 BFF 통합: go register/login 흐름에서 v2 까지 함께 호출,
 * v2 의 Set-Cookie 응답을 go 응답에 그대로 포워딩.
 *
 * 실패 시 throw — 호출자가 fallback 처리 결정.
 */
import { logger } from "@/lib/logger";

const V2_BASE = process.env.V2_INTERNAL_BASE_URL ?? "https://api-staging.pickket.kr";

export interface V2AuthResult {
  /** v2 access JWT — go 측 검증용 (MFA 대기 시 "") */
  accessToken: string;
  /** v2 user_id (UUID) (MFA 대기 시 "") */
  v2UserId: string;
  /** v2 가 응답에 set 한 Set-Cookie 헤더 raw 배열 (.pickket.kr domain) */
  setCookieHeaders: string[];
  /** v2 가 MFA 2차 인증을 요구 — 이 경우 세션 미발급, mfaToken 으로 /mfa/verify 진행 (P2-C9) */
  mfaRequired?: boolean;
  mfaToken?: string;
}

/**
 * 원본 클라이언트 요청 컨텍스트. v2 의 봇차단/레이트리밋이 실제 최종 사용자
 * 기준으로 동작하도록 BFF 호출에 그대로 전달한다.
 *
 * 미전달 시: v2 는 go 서버를 컨텍스트 없는 호출로 보고 bot_detected 로 차단하거나,
 * 모든 로그인 트래픽을 go 단일 IP 로 집계해 레이트리밋이 오작동한다.
 */
export interface V2ClientContext {
  userAgent?: string | null;
  forwardedFor?: string | null;
  acceptLanguage?: string | null;
}

/** BFF→v2 호출용 헤더 구성. UA 누락 시 최소한 서비스 식별자를 보내 봇차단을 회피한다. */
export function buildForwardHeaders(ctx?: V2ClientContext): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers["User-Agent"] = ctx?.userAgent || "pickket-go-bff/1.0";
  if (ctx?.forwardedFor) headers["X-Forwarded-For"] = ctx.forwardedFor;
  if (ctx?.acceptLanguage) headers["Accept-Language"] = ctx.acceptLanguage;
  // E2E 테스트 컨텍스트 신호 — v2 가 dev/test env(AUTH_TEST_BYPASS_ENABLED)에서만
  // 계정잠금/로그인 레이트리밋을 우회하도록(prod 에선 v2 가 무시). go 의 PLAYWRIGHT_TEST
  // 레이트리밋 우회와 대칭. 이 헤더는 PLAYWRIGHT_TEST=1 일 때만 전송되며, prod 코드경로엔
  // 절대 실리지 않는다(보안: v2 가 자기 env 로 게이트).
  if (process.env.PLAYWRIGHT_TEST === "1") {
    headers["X-Pickket-Test-Bypass"] = "1";
  }
  return headers;
}

/** Request 헤더에서 전달할 클라이언트 컨텍스트를 추출. */
export function extractClientContext(request: Request): V2ClientContext {
  return {
    userAgent: request.headers.get("user-agent"),
    forwardedFor:
      request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"),
    acceptLanguage: request.headers.get("accept-language"),
  };
}

interface V2User {
  id: string;
  email: string;
  name: string;
  is_organizer: boolean;
  is_admin: boolean;
}

interface V2TokenResponse {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  user?: V2User; // MFA 대기 응답에는 user 가 없을 수 있음
  mfa_required?: boolean;
  mfa_token?: string;
}

function extractSetCookies(res: Response): string[] {
  // Next.js / undici Headers 가 multiple Set-Cookie 를 어떻게 노출하는지 확인.
  // Headers.getSetCookie() 가 표준 (Node 20.11+).
  type ExtendedHeaders = Headers & { getSetCookie?: () => string[] };
  const h = res.headers as ExtendedHeaders;
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  // fallback: header 통째로 가져오기 (multiple 일 경우 콤마로 join 되어있을 수 있음 — 부정확)
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * v2 auth 실패를 상태코드 + 사용자향 메시지와 함께 전달하는 에러.
 * 라우트는 4xx(검증 등)를 그대로 사용자에게 노출한다 — 5xx 로 반환하면 Cloudflare 가
 * HTML 에러페이지로 바꿔 "Unexpected token '<'" 로 보이고 진짜 원인(예: 비밀번호 규칙)이
 * 숨는다.
 */
export class V2AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "V2AuthError";
  }
}

/** v2(FastAPI) 에러 본문에서 사용자에게 보여줄 메시지를 추출한다. */
function extractV2ErrorMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    // FastAPI 검증 오류: { detail: [{ msg, loc }] }
    if (Array.isArray(body.detail)) {
      const first = body.detail[0] as { msg?: string } | undefined;
      if (first?.msg) return String(first.msg).replace(/^Value error,\s*/, "");
    }
    // FastAPI HTTPException: { detail: "..." }
    if (typeof body.detail === "string") return body.detail;
  } catch {
    /* JSON 아니면 폴백 */
  }
  return status >= 400 && status < 500 ? "입력값을 확인해주세요." : "처리에 실패했습니다. 잠시 후 다시 시도해주세요.";
}

export async function v2Register(input: {
  email: string;
  password: string;
  name: string;
  phone?: string;
  is_organizer?: boolean;
}, ctx?: V2ClientContext): Promise<V2AuthResult> {
  const res = await fetch(`${V2_BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: buildForwardHeaders(ctx),
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      name: input.name,
      phone: input.phone ?? null,
      is_organizer: input.is_organizer ?? true,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn("v2 register 실패", { status: res.status, body: text.slice(0, 300) });
    throw new V2AuthError(res.status, extractV2ErrorMessage(res.status, text));
  }

  const json = (await res.json()) as V2TokenResponse;
  return {
    accessToken: json.access_token,
    v2UserId: json.user?.id ?? "",
    setCookieHeaders: extractSetCookies(res),
  };
}

export async function v2Login(input: {
  email: string;
  password: string;
}, ctx?: V2ClientContext): Promise<V2AuthResult> {
  const res = await fetch(`${V2_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: buildForwardHeaders(ctx),
    body: JSON.stringify({ email: input.email, password: input.password }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn("v2 login 실패", { status: res.status, body: text.slice(0, 300) });
    throw new V2AuthError(res.status, extractV2ErrorMessage(res.status, text));
  }

  const json = (await res.json()) as V2TokenResponse;
  // MFA 필요 시 v2 는 세션 토큰 없이 mfa_token 만 반환 — 세션 미발급으로 fail-closed (P2-C9).
  if (json.mfa_required) {
    return {
      accessToken: "",
      v2UserId: "",
      setCookieHeaders: [],
      mfaRequired: true,
      mfaToken: json.mfa_token,
    };
  }
  return {
    accessToken: json.access_token,
    v2UserId: json.user?.id ?? "",
    setCookieHeaders: extractSetCookies(res),
  };
}

/**
 * MFA 2차 인증 — v2 /api/v1/auth/mfa/verify 에 mfa_token + TOTP code 전달.
 * 성공 시 v2 가 실제 세션 토큰/쿠키 발급 → go 가 forward.
 */
export async function v2MfaVerify(
  input: { mfaToken: string; code: string },
  ctx?: V2ClientContext,
): Promise<V2AuthResult> {
  const res = await fetch(`${V2_BASE}/api/v1/auth/mfa/verify`, {
    method: "POST",
    headers: buildForwardHeaders(ctx),
    body: JSON.stringify({ mfa_token: input.mfaToken, code: input.code }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`v2 mfa verify HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as V2TokenResponse;
  return {
    accessToken: json.access_token,
    v2UserId: json.user?.id ?? "",
    setCookieHeaders: extractSetCookies(res),
  };
}

/**
 * v2 의 Set-Cookie 헤더를 go 응답에 그대로 forward.
 * NextResponse 빌드 시 호출.
 */
export function forwardSetCookies(response: Response, cookies: string[]): void {
  for (const c of cookies) {
    response.headers.append("set-cookie", c);
  }
}

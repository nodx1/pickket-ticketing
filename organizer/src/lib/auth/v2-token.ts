/**
 * v2 access token (JWT HS256) 자체 검증.
 *
 * v2 는 access token 을 SECRET_KEY (= V2_JWT_SECRET) 으로 HS256 서명.
 * go 는 동일 secret 으로 자체 검증해서 HTTP 호출 없이 유효성 판단.
 *
 * Payload: { sub: <v2_user_id UUID>, exp, iat, iss, aud, type: 'access' | 'refresh' }
 *
 * 토큰 위치: 브라우저 cookie `pickket_access` (HttpOnly, Domain=.pickket.kr)
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";

/**
 * v2 verify-token 응답 — 레벨2 2차 D2.
 * go 세션 구성에 필요한 프로필/앵커를 go DB 조회 없이 v2 로부터 받는다.
 */
export interface V2VerifyTokenResult {
  valid: boolean;
  userId: string | null;
  email: string | null;
  name: string | null;
  phone: string | null;
  isOrganizer: boolean;
  isAdmin: boolean;
  /** OrganizerProfile.go_account_id — write-through goAccountRef 앵커(=session.accountId). */
  goAccountId: string | null;
  /** organizer_ref(=organizer_id=v2 user_id) — read/write organizer_ref. */
  organizerRef: string | null;
  /** go 세션 역할 — v2 가 멤버십 role 을 go 어휘로 매핑해 준다. null 이면 호출측이 폴백. */
  organizerRole: string | null;
  /** 남의 조직을 가리키는 앵커일 때만 채워진다(팀 멤버). 감사·디버깅용. */
  membershipOf: string | null;
}

interface V2VerifyTokenResponseBody {
  valid: boolean;
  user_id?: string | null;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  is_organizer?: boolean;
  is_admin?: boolean;
  go_account_id?: string | null;
  organizer_ref?: string | null;
  organizer_role?: string | null;
  membership_of?: string | null;
}

// env 는 호출 시점 lazy read(모듈 로드 시점 캡처 금지 — commerce-client 와 동일 교훈).
function getV2Base(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
function getServiceToken(): string | undefined {
  // v2 verify-token 은 INTERNAL_SERVICE_TOKEN 검증(전환기 GO_WEBHOOK_SECRET 폴백).
  return (
    process.env.V2_INTERNAL_SERVICE_TOKEN ??
    process.env.GO_WEBHOOK_SECRET ??
    process.env.V2_EVENT_SYNC_SECRET
  );
}

/**
 * v2 /auth/verify-token 호출 — 토큰 검증 + go 세션 앵커(go_account_id/organizer_ref) 수신.
 *
 * go DB(users/accounts) 무의존 세션 구성의 핵심(레벨2 2차 D2). 서비스 토큰 미설정/네트워크
 * 실패/비2xx 는 null 반환(호출자가 세션 미발급=401 로 처리 — fail-closed).
 */
export async function verifyV2TokenRemote(
  token: string,
): Promise<V2VerifyTokenResult | null> {
  const base = getV2Base();
  const serviceToken = getServiceToken();
  if (!base || !serviceToken) {
    logger.warn("v2 verify-token 스킵: V2_INTERNAL_BASE_URL/서비스토큰 미설정");
    return null;
  }

  try {
    const res = await fetch(`${base}/api/v1/auth/verify-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Service-Token": serviceToken,
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn("v2 verify-token 비2xx", { status: res.status });
      return null;
    }
    const data = (await res.json()) as V2VerifyTokenResponseBody;
    return {
      valid: Boolean(data.valid),
      userId: data.user_id ?? null,
      email: data.email ?? null,
      name: data.name ?? null,
      phone: data.phone ?? null,
      isOrganizer: Boolean(data.is_organizer),
      isAdmin: Boolean(data.is_admin),
      goAccountId: data.go_account_id ?? null,
      organizerRef: data.organizer_ref ?? null,
      organizerRole: data.organizer_role ?? null,
      membershipOf: data.membership_of ?? null,
    };
  } catch (err: unknown) {
    logger.warn("v2 verify-token 에러", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
}

export interface V2AccessPayload {
  sub: string;
  exp: number;
  iat: number;
  nbf?: number;
  iss: string;
  aud: string | string[];
  type: "access" | "refresh";
}

interface JwtHeader {
  alg: string;
  typ?: string;
}

function base64UrlDecode(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function verifyV2AccessToken(token: string): V2AccessPayload | null {
  const secret = process.env.V2_JWT_SECRET;
  const expectedIssuer = process.env.V2_JWT_ISSUER;
  const expectedAudience = process.env.V2_JWT_AUDIENCE;
  if (!secret || !expectedIssuer || !expectedAudience) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  // 1) 헤더 고정 — alg confusion 방지.
  let header: JwtHeader;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  if (header.typ && header.typ !== "JWT") return null;

  // 2) 서명 검증 (HS256)
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  let actual: Buffer;
  try {
    actual = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    return null;
  }

  // 3) 페이로드 파싱
  let payload: V2AccessPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  // 4) 표준 클레임 검증
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (typeof payload.iat !== "number" || payload.iat > now + 60) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now) return null;
  if (payload.iss !== expectedIssuer) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expectedAudience)) return null;

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.sub,
    )
  ) {
    return null;
  }

  // 5) access 토큰만 허용 (refresh 거부)
  if (payload.type !== "access") return null;

  return payload;
}

/**
 * 클라이언트 IP 유도 — **정본 하나**.
 *
 * ── 왜 필요한가 (2026-07-30 실측) ──
 * 같은 판정이 20지점에 각자 인라인돼 있었고, 방식이 5종으로 갈려 있었다.
 * 그 중 가장 흔한 형태가 이것인데, **공격자가 정한 값을 그대로 집는다**:
 *
 *     request.headers.get("x-forwarded-for")?.split(",")[0]     // ← 가장 왼쪽
 *
 * ── 실측된 우리 토폴로지 ──
 *   클라이언트 → Cloudflare 엣지 → captain nginx → 앱 컨테이너
 *
 *   · `dig A go.pickket.kr` → CF anycast · 응답 헤더 `cf-ray` → **CF 프록시 확정**
 *     ⟹ `CF-Connecting-IP` 는 프로덕션 요청에 **항상 존재**한다.
 *   · CapRover nginx 는 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
 *     ⟹ **append** 다(덮어쓰지 않는다). 클라이언트가 보낸 값이 체인 **앞머리에 남는다**.
 *   · 같은 설정의 `X-Real-IP $remote_addr` 는 **CF 엣지 IP** 다 — captain 에 접속하는
 *     상대가 CF 이기 때문. ⟹ 사용자 식별에 **쓸 수 없다**(같은 PoP 사용자가 전부 한 값).
 *
 * 따라서 프로덕션의 체인은 이런 모양이 된다:
 *
 *     X-Forwarded-For: <클라이언트가 위조한 값…>, <CF 가 본 실제 IP>, <CF 엣지 IP>
 *                       └ 왼쪽을 집으면 위조값        └ 오른쪽을 집으면 CF 엣지
 *
 * **XFF 만으로는 양쪽 다 틀린다.** 그래서 `CF-Connecting-IP` 가 1순위다.
 *
 * ── Next.js 제약 ──
 * v2(`platform/backend/app/core/network.py`)는 `request.client.host` 로 "직접 연결 상대가
 * 신뢰 프록시 CIDR 인가"를 먼저 본다. **Next.js route handler 에는 socket peer 주소가 없다.**
 * 그래서 그 검사를 옮길 수 없고, 대신 "CF 를 거쳤다는 증거"로 대체한다.
 * (`api/public/inquiries/route.ts` 가 CIDR 대신 boolean `TRUSTED_PROXY` 를 쓴 이유가 같다)
 *
 * ⚠️ 이 함수는 **CF 를 거친 요청에서만** 신뢰할 수 있다. 오리진이 CF 우회로 직접 도달
 *    가능하면 공격자가 `CF-Connecting-IP` 를 직접 지어낼 수 있다.
 *    정본 해결은 Cloudflare Authenticated Origin Pulls 또는 nginx 의 CF 대역 제한이며
 *    **인프라 작업이다**(`docs/audit/CLIENT-IP-DERIVATION-20260730.md`).
 */

/** `Headers` 와 `Request.headers` 를 모두 받기 위한 최소 인터페이스(테스트 주입 목적). */
export interface HeaderReader {
  get(name: string): string | null;
}

export type ClientIpSource = "cf" | "xff";

export interface ResolvedClientIp {
  ip: string;
  source: ClientIpSource;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    // "01" 같은 선행 0 은 거부한다 — 8진수로 해석되는 파서와 값이 갈린다.
    if (part.length > 1 && part.startsWith("0")) return false;
    return Number(part) <= 255;
  });
}

function isIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;
  // 보수적 판정 — 압축(::) 형태와 완전 형태만 통과시킨다.
  if (value.includes("::")) return value.split("::").length === 2;
  return /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(value);
}

/** IP 리터럴인가 — 형식 불량은 채택하지 않는다(로그 오염·키 오염 방지). */
export function isIpLiteral(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

/**
 * 사설·루프백·링크로컬 — XFF 체인에서 **인프라 홉**을 건너뛰기 위한 판정.
 * (docker 브리지 `172.x`, LAN `192.168.x`, 컨테이너 루프백 등)
 */
export function isPrivateIp(value: string): boolean {
  if (isIpv4(value)) {
    const [a, b] = value.split(".").map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true;
    return false;
  }
  const lower = value.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 유니크 로컬
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 링크로컬
  return false;
}

/**
 * 클라이언트 IP 를 해석한다.
 *
 * 우선순위
 *   1. `CF-Connecting-IP` — 형식검증 통과 시 채택. 프로덕션의 정답이다.
 *   2. `X-Forwarded-For` — **우→좌**로 훑어 사설 홉을 건너뛴 첫 값.
 *      CF 를 거치지 않는 환경(로컬·직접 호출)을 위한 폴백이며,
 *      🔴 CF 뒤에서는 **CF 엣지 IP 를 집을 수 있다** — 그래서 1순위가 CF 헤더다.
 *   3. `X-Real-IP` — **쓰지 않는다.** 우리 nginx 설정에서 CF 엣지 IP 다(상단 주석).
 *
 * @returns 해석 실패 시 `null`. **`"unknown"`·`"anonymous"` 같은 문자열을 만들지 않는다** —
 *          없는 것을 있는 것처럼 만들면 원장에 "unknown 이라는 IP" 가 남고,
 *          레이트리밋에서는 전원이 한 버킷을 공유한다(= 한 명이 전체를 막는다).
 */
export function resolveClientIp(headers: HeaderReader): ResolvedClientIp | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf && isIpLiteral(cf)) return { ip: cf, source: "cf" };

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const chain = forwarded.split(",").map((part) => part.trim());
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const candidate = chain[i];
      if (!candidate || !isIpLiteral(candidate)) continue;
      if (isPrivateIp(candidate)) continue;
      return { ip: candidate, source: "xff" };
    }
  }

  return null;
}

/**
 * 감사 기록용 — 문자열 또는 `null`.
 * 기록은 판정 실패를 **그대로 남긴다**(거부하지 않는다). 거부는 레이트리밋 쪽 정책이다.
 */
export function auditClientIp(headers: HeaderReader): string | null {
  return resolveClientIp(headers)?.ip ?? null;
}

/**
 * CF 를 **거치지 않는** 내부 경로 — IP 로 식별할 수 없고, 해서도 안 된다.
 *
 * 🔴 실측(2026-07-30): prod backend env `GO_INTERNAL_BASE_URL` =
 *    `http://srv-captain--pickket-organizer:3003` — v2 는 go 를 **도커 내부망**으로 부른다.
 *    Cloudflare 를 거치지 않으므로 `CF-Connecting-IP` 도 `X-Forwarded-For` 도 없다.
 *    "식별 실패 = 거부" 를 이 경로에 적용하면 **주문 상태 전파·사업자 심사·이벤트 심사
 *    결과 수신이 전부 죽는다.** 예외를 먼저 심지 않고 거부를 켜면 안 된다.
 *
 * 예외로 빼도 구멍이 아닌 근거 — 셋 다 공유 시크릿으로 인증한다:
 *   · `/api/internal/orders/state-changed`      HMAC(`GO_WEBHOOK_SECRET`)
 *   · `/api/internal/business-verifications`    `X-Pickket-Service-Token`
 *   · `/api/v2-webhook/**`                      HMAC(`V2_EVENT_SYNC_SECRET`)
 *   · `/api/health/**`                          인증 없음(정상) — 읽기 전용 상태 조회.
 *     도커 헬스체크는 컨테이너에 **직접** 붙으므로 프록시 헤더가 없다.
 *
 * ⚠️ 크론은 예외가 **아니다** — `scripts/ops/install-crontab.sh:45` 가
 *    `https://go.pickket.kr/api/cron` 를 쓴다(CF 경유). 실측으로 확인했다.
 */
export function isUnproxiedInternalPath(pathname: string): boolean {
  // ⚠️ 접두사를 느슨하게 잡으면 예외가 구멍이 된다 — `startsWith("/api/health")` 하나면
  //    미래의 `/api/healthz`·`/api/health-report` 가 공짜로 IP 게이트를 벗어난다.
  //    정확히 그 라우트와 그 하위만 본다(테스트가 이 실수를 잡아냈다).
  return (
    pathname === "/api/health" ||
    pathname.startsWith("/api/health/") ||
    pathname.startsWith("/api/internal/") ||
    pathname.startsWith("/api/v2-webhook/")
  );
}

/** 프록시를 안 거친 로컬 실행에서 쓰는 고정 키 — 프로덕션에서는 절대 쓰이지 않는다. */
export const LOCAL_RATE_LIMIT_KEY = "local-unproxied";

/**
 * 레이트리밋 버킷 키.
 *
 * @param strict 프로덕션 런타임인가(`isProdRuntime()`). CF 뒤에서는 IP 가 **항상** 해석되므로
 *               실패는 ① 인프라 오설정 ② CF 우회 직접접속 중 하나다 — 둘 다 통과시킬 이유가 없다.
 * @returns 키, 또는 **`null`(= 호출측이 거부해야 한다)**.
 *          🔴 종전의 `"unknown"`·`"anonymous"` 폴백은 전원을 **한 버킷**에 합쳐,
 *             한 명이 한도를 채우면 나머지 전원이 막혔다(문의 폼이 실제로 그 상태였다).
 */
export function rateLimitKey(headers: HeaderReader, strict: boolean): string | null {
  const resolved = resolveClientIp(headers);
  if (resolved) return resolved.ip;
  return strict ? null : LOCAL_RATE_LIMIT_KEY;
}

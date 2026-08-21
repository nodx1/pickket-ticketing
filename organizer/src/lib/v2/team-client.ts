/**
 * v2 조직 팀 멤버 원장 클라이언트.
 *
 * ## 왜 필요한가 (2026-07-31)
 * 팀원 관리 화면이 **go `users` 테이블**을 조회했다. 레벨2 컷오버로 그 원장이 비면서
 * SQL 은 성공하고 **에러 없이 "팀원 0명"** 이 나왔다 — 장애로 보이지 않는 파손이었다.
 * 정본은 v2 `organizer_team_members` 다.
 *
 * ## 인증
 * `X-Pickket-Service-Token` — 이 리포의 다른 internal read 클라이언트와 같은 계약이다
 * (HMAC 서명은 write 이벤트용이고, internal 라우터는 서비스 토큰을 본다).
 *
 * ⚠️ env 는 **호출 시점 lazy read** 다. 모듈 로드 시점에 캡처하면 cron·tsx 로더에서
 *    빈 값이 잡힌다(리포의 다른 클라이언트가 같은 이유로 lazy 다).
 */
import { logger } from "@/lib/logger";

export interface V2TeamMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  joinedAt: string | null;
}

/** v2 호출 실패 — 호출부가 **조용히 0명으로 처리하지 않도록** 명시적으로 던진다. */
export class V2TeamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "V2TeamError";
  }
}

function base(): string {
  const b = process.env.V2_INTERNAL_BASE_URL;
  if (!b) throw new V2TeamError(0, "V2_INTERNAL_BASE_URL 미설정");
  return b.replace(/\/$/, "");
}

function serviceToken(): string {
  // 리포 계약: 전용 토큰 우선, 전환기엔 웹훅 시크릿 폴백(v2 config 와 같은 규칙).
  const t = process.env.INTERNAL_SERVICE_TOKEN ?? process.env.GO_WEBHOOK_SECRET;
  if (!t) throw new V2TeamError(0, "INTERNAL_SERVICE_TOKEN/GO_WEBHOOK_SECRET 미설정");
  return t;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base()}/api/v1/internal${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Pickket-Service-Token": serviceToken(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new V2TeamError(res.status, `v2 team ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; data?: T; error?: { message?: string } };
    if (parsed.ok === false) {
      throw new V2TeamError(res.status, parsed.error?.message ?? "v2 team 오류");
    }
    return (parsed.data ?? parsed) as T;
  } catch (err) {
    if (err instanceof V2TeamError) throw err;
    throw new V2TeamError(res.status, `v2 team 응답 파싱 실패: ${text.slice(0, 160)}`);
  }
}

/** 조직 팀 멤버 목록(org 레벨만). */
export function listTeamMembers(organizerRef: string): Promise<{ members: V2TeamMember[] }> {
  return call("GET", `/organizers/${encodeURIComponent(organizerRef)}/team`);
}

/**
 * 팀 멤버 해제 — 멤버십만 지운다(계정은 살아 있다).
 *
 * 🔴 해제는 되돌릴 수 없는 접근권 변경이다. 다음 요청부터 그 사람은 조직을 못 본다
 *    (토큰 5분 + go 가 매 요청 verify-token 을 부르므로 전파는 즉시).
 */
export function removeTeamMember(
  organizerRef: string,
  userId: string,
): Promise<{ removed: boolean; count?: number }> {
  return call("DELETE", `/organizers/${encodeURIComponent(organizerRef)}/team/${encodeURIComponent(userId)}`);
}

/** 팀 멤버 역할 변경(in-place). */
export function updateTeamMemberRole(
  organizerRef: string,
  userId: string,
  role: string,
): Promise<{ updated: boolean; role: string }> {
  return call(
    "PATCH",
    `/organizers/${encodeURIComponent(organizerRef)}/team/${encodeURIComponent(userId)}`,
    { organizer_ref: organizerRef, role },
  );
}

/** 실패를 로그에 남기고 다시 던진다 — 호출부가 "0명" 으로 위장하지 않게. */
export function logTeamFailure(op: string, err: unknown): void {
  logger.error(`v2 팀 원장 ${op} 실패`, {
    error: err instanceof Error ? err.message : "unknown",
    status: err instanceof V2TeamError ? err.status : undefined,
  });
}

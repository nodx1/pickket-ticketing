/**
 * 세션 구성 단일 소스 — 레벨2 영역D(2차 D2).
 *
 * v2 access JWT(payload.sub = v2_user_id)를 자체검증한 뒤, v2 verify-token 으로 세션을 만든다.
 * withAuth / getServerSession / verifySession 이 **모두** 이 헬퍼를 공유해 로직 분기를 없앤다.
 *
 * ── 2차 D2: go DB(users/accounts) 완전 무의존 ──
 *   1차엔 session.accountId(=go accounts.id)를 얻으려 go users 를 조회했다. 이제 v2 register
 *   가 OrganizerProfile(go_account_id 앵커)을 만들고 verify-token 이 그 값을 반환하므로,
 *   세션 구성이 go DB 를 전혀 읽지 않는다. accounts/users DROP(D7/D8)의 선행조건이 충족된다.
 *
 *   - session.accountId = verify-token.go_account_id (write-through goAccountRef 앵커).
 *       · 신규 주최자: go_account_id = v2_user_id(self-anchor) → events.account_id 도 동일.
 *       · 기존(마이그레이션) 조직: go_account_id = 옛 accounts.id → 기존 events 정합 보존.
 *   - session.v2UserId = payload.sub = organizer_ref(=organizer_id). read 3라우트가 소비.
 *
 * ── 검증 순서 ──
 *   1) 로컬 HS256 자체검증(verifyV2AccessToken) — 서명/만료 즉시 판별(잘못된 토큰에 HTTP 낭비 방지).
 *   2) v2 verify-token(HTTP) — 프로필/앵커 수신 + user_not_found/삭제 등 서버측 최종 판정.
 *      네트워크/서비스토큰 실패 시 null → withAuth 가 401(fail-closed).
 */
import { verifyV2AccessToken, verifyV2TokenRemote } from "@/lib/auth/v2-token";
import { parseUserRole } from "@/lib/auth/permissions";
import type { User } from "@/lib/types";

/** 세션을 못 만든 이유 — `not_organizer` 는 로그인은 됐지만 주최사 계정이 아닌 경우다. */
export type SessionFailure = "invalid" | "not_organizer";

export type SessionResult =
  | { session: User; failure: null }
  | { session: null; failure: SessionFailure };

export { NOT_ORGANIZER_CODE, NOT_ORGANIZER_MESSAGE } from "@/lib/auth/not-organizer";

/**
 * 피켓고를 쓸 수 있는 계정인가 — 주최사 본인이거나 주최사 팀 멤버.
 *
 * 🔴 2026-11-24: 피켓(pickket.kr)과 피켓고는 로그인 쿠키(`pickket_access`, `.pickket.kr`)를
 *    공유한다. 피켓에서 팬 계정으로 로그인하면 피켓고도 그 계정이 되는데, 종전엔 여기서
 *    걸러내지 않고 역할을 `owner` 로 폴백해 통과시켰다. 그 뒤 v2 커머스가 「주최자 아님」으로
 *    거절하면 라우트들이 그걸 「커머스 서버에 연결할 수 없습니다」(503)로 보여 줬다.
 * ⚠️ `organizerRef` 는 주최사 프로필 또는 팀 멤버십이 있을 때만 채워진다. `isOrganizer` 도
 *    함께 보는 이유는 organizer_ref 를 아직 안 주는 v2 배포본과의 하위호환이다.
 */
export function isOrganizerAccount(remote: { organizerRef: string | null; isOrganizer: boolean }): boolean {
  return Boolean(remote.organizerRef) || remote.isOrganizer;
}

/**
 * v2 access token 문자열로부터 세션(User)을 구성한다.
 * 토큰 무효/유저 없음/비활성 → null.
 *
 * @param token v2 access JWT (cookie `pickket_access` 또는 Bearer).
 */
export async function resolveSessionFromToken(token: string): Promise<User | null> {
  return (await resolveSessionResult(token)).session;
}

/**
 * {@link resolveSessionFromToken} 과 같지만 실패 이유를 함께 준다.
 * 화면이 「다시 로그인」과 「주최사 계정으로 로그인」을 구분해 안내할 때 쓴다.
 */
export async function resolveSessionResult(token: string): Promise<SessionResult> {
  const invalid = { session: null, failure: "invalid" } as const;
  // 1) 로컬 자체검증 — 서명·만료·issuer/audience 확정. 실패면 HTTP 없이 즉시 null.
  const payload = verifyV2AccessToken(token);
  if (!payload) return invalid;

  // 2) v2 verify-token — 프로필/앵커(go_account_id, organizer_ref) 수신. go DB 미조회.
  const remote = await verifyV2TokenRemote(token);
  if (!remote || !remote.valid || !remote.userId) return invalid;
  // sub 불일치는 신뢰경계 위반 — 거부.
  if (remote.userId !== payload.sub) return invalid;
  if (!isOrganizerAccount(remote)) return { session: null, failure: "not_organizer" };

  // accountId 앵커: go_account_id 우선, 부재 시(레거시 미보정) v2 user_id 폴백.
  const accountId = remote.goAccountId ?? remote.userId;
  const nowIso = new Date().toISOString();

  const session: User = {
    id: remote.userId,
    accountId,
    email: remote.email ?? "",
    name: remote.name ?? "",
    /**
     * 🔴 종전엔 `"owner"` 하드코딩이었다 (2026-07-31 복구 전).
     *
     * v2 가 이제 팀 멤버십을 해석해 `organizer_role` 을 준다:
     *   조직 소유자 → "owner" · 팀 매니저 → "organizer" · 뷰어 → "staff"
     *
     * ⚠️ 폴백이 `"owner"` 인 이유: v2 가 아직 이 필드를 안 주는 배포본일 수 있다
     *    (v2 → go 순서로 나가므로 그 사이 창이 존재한다). 그 창에서 기존 주최자를
     *    막아버리면 판매가 멈춘다 — **없으면 종전 동작**으로 둔다.
     * ⚠️ 반대로 팀원은 그 창에서 조직이 안 보인다. 배포 순서를 지켜야 하는 이유다.
     */
    role: (remote.organizerRole ? parseUserRole(remote.organizerRole) : null) ?? "owner",
    phone: remote.phone,
    passwordHash: "",
    isActive: true,
    mfaEnabled: false,
    lastLoginAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    // 앵커: JWT sub = v2 canonical user id. resolveOrganizerRef 가 go DB 재조회 없이 소비.
    v2UserId: remote.organizerRef ?? payload.sub,
  };
  return { session, failure: null };
}

import { afterEach, describe, expect, it, vi } from "vitest";

// v2-token 검증(로컬 HS256) + verify-token(원격 HTTP) 격리 (hoisted 홀더).
const h = vi.hoisted(() => ({
  verify: vi.fn(),
  remote: vi.fn(),
}));
vi.mock("@/lib/auth/v2-token", () => ({
  verifyV2AccessToken: (...a: unknown[]) => h.verify(...a),
  verifyV2TokenRemote: (...a: unknown[]) => h.remote(...a),
}));

import { resolveSessionFromToken, resolveSessionResult } from "@/lib/auth/resolve-session";

const V2_SUB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function remoteOk(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    userId: V2_SUB,
    email: "org@example.com",
    name: "주최자",
    phone: "010-1234-5678",
    isOrganizer: true,
    isAdmin: false,
    goAccountId: "go-acc-1",
    organizerRef: V2_SUB,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveSessionFromToken (레벨2 2차 D2 세션 단일소스 — go DB 무의존)", () => {
  it("토큰 무효면 null 반환(원격 verify-token 호출 안 함)", async () => {
    h.verify.mockReturnValue(null);
    const session = await resolveSessionFromToken("bad.token");
    expect(session).toBeNull();
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("유효 토큰 + verify-token → 세션 구성, accountId=go_account_id 앵커", async () => {
    h.verify.mockReturnValue({ sub: V2_SUB, type: "access" });
    h.remote.mockResolvedValue(remoteOk());
    const session = await resolveSessionFromToken("good.token");
    expect(session).not.toBeNull();
    expect(session?.id).toBe(V2_SUB);
    expect(session?.accountId).toBe("go-acc-1"); // write-through 앵커
    expect(session?.role).toBe("owner");
    expect(session?.v2UserId).toBe(V2_SUB); // organizer_ref 앵커
    expect(session?.passwordHash).toBe(""); // 비번은 v2 소유 → 공란
  });

  it("go_account_id 부재(레거시 미보정) → v2 user_id 폴백", async () => {
    h.verify.mockReturnValue({ sub: V2_SUB, type: "access" });
    h.remote.mockResolvedValue(remoteOk({ goAccountId: null }));
    const session = await resolveSessionFromToken("good.token");
    expect(session?.accountId).toBe(V2_SUB);
  });

  it("verify-token 실패/null(네트워크·서비스토큰) → null(fail-closed)", async () => {
    h.verify.mockReturnValue({ sub: V2_SUB, type: "access" });
    h.remote.mockResolvedValue(null);
    const session = await resolveSessionFromToken("good.token");
    expect(session).toBeNull();
  });

  it("verify-token valid=false(유저 삭제 등) → null", async () => {
    h.verify.mockReturnValue({ sub: V2_SUB, type: "access" });
    h.remote.mockResolvedValue(remoteOk({ valid: false }));
    const session = await resolveSessionFromToken("good.token");
    expect(session).toBeNull();
  });

  it("sub 불일치(신뢰경계 위반) → null", async () => {
    h.verify.mockReturnValue({ sub: V2_SUB, type: "access" });
    h.remote.mockResolvedValue(
      remoteOk({ userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    );
    const session = await resolveSessionFromToken("good.token");
    expect(session).toBeNull();
  });
});

/**
 * 2026-11-24 — 피켓(팬)과 피켓고가 로그인 쿠키를 공유한다. 팬 계정이 피켓고 세션이 되면
 * v2 커머스가 「주최자 아님」으로 거절하고, 화면엔 「커머스 서버 연결 불가」(503)가 떴다.
 */
describe("주최사가 아닌 계정 (피켓 팬 로그인 공유)", () => {
  it("주최사 프로필·팀 멤버십이 없는 팬 계정은 세션을 만들지 않고 이유를 not_organizer 로 준다", async () => {
    h.verify.mockReturnValue({ sub: V2_SUB, type: "access" });
    h.remote.mockResolvedValue(
      remoteOk({ isOrganizer: false, organizerRef: null, goAccountId: null, organizerRole: null }),
    );

    expect(await resolveSessionFromToken("fan.token")).toBeNull();
    expect(await resolveSessionResult("fan.token")).toEqual({ session: null, failure: "not_organizer" });
  });

  it("본인은 주최사가 아니어도 주최사 팀 멤버(organizer_ref 있음)면 세션을 만든다", async () => {
    const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    h.verify.mockReturnValue({ sub: V2_SUB, type: "access" });
    h.remote.mockResolvedValue(
      remoteOk({ isOrganizer: false, organizerRef: OWNER, goAccountId: OWNER, organizerRole: "organizer" }),
    );

    const result = await resolveSessionResult("member.token");
    expect(result.failure).toBeNull();
    expect(result.session?.role).toBe("organizer");
    expect(result.session?.v2UserId).toBe(OWNER);
  });

  it("organizer_ref 를 아직 안 주는 v2 라도 is_organizer 면 종전대로 통과한다(하위호환)", async () => {
    h.verify.mockReturnValue({ sub: V2_SUB, type: "access" });
    h.remote.mockResolvedValue(remoteOk({ organizerRef: null }));

    const result = await resolveSessionResult("legacy.token");
    expect(result.session?.role).toBe("owner");
  });

  it("토큰 자체가 무효면 이유는 invalid 다(주최사 안내가 아니라 다시 로그인)", async () => {
    h.verify.mockReturnValue(null);
    expect(await resolveSessionResult("bad.token")).toEqual({ session: null, failure: "invalid" });
  });
});


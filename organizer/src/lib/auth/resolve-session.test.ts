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

import { resolveSessionFromToken } from "@/lib/auth/resolve-session";

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

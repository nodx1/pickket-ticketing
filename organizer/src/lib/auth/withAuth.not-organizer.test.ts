/**
 * 피켓 팬 계정으로 로그인된 채 피켓고 API 를 부르면 403 + NOT_ORGANIZER 로 답한다.
 *
 * 🔴 종전엔 팬 세션이 `owner` 로 통과했고, 그 뒤 v2 가 거절한 것을 라우트들이
 *    「커머스 서버에 연결할 수 없습니다」(503)로 보여 줬다(2026-11-24 실결제 시험 중 확인).
 *    401 이 아니라 403 인 이유: 토큰 갱신으로는 바뀌지 않는다 — 계정을 바꿔야 한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ resolve: vi.fn(), token: "fan.token" as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "pickket_access" && h.token ? { value: h.token } : undefined) }),
}));
vi.mock("@/lib/auth/resolve-session", async () => {
  const notOrg = await import("@/lib/auth/not-organizer");
  return {
    NOT_ORGANIZER_CODE: notOrg.NOT_ORGANIZER_CODE,
    NOT_ORGANIZER_MESSAGE: notOrg.NOT_ORGANIZER_MESSAGE,
    resolveSessionResult: (...a: unknown[]) => h.resolve(...a),
  };
});
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { withAuth } from "@/lib/auth/withAuth";
import { NOT_ORGANIZER_CODE, NOT_ORGANIZER_MESSAGE } from "@/lib/auth/not-organizer";

function call(handler = vi.fn(async () => new Response("ok"))) {
  const route = withAuth(handler);
  return { handler, res: route(new Request("http://localhost/api/events") as never, { params: Promise.resolve({}) }) };
}

describe("withAuth — 주최사가 아닌 계정", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.token = "fan.token";
  });

  it("팬 세션이면 핸들러를 부르지 않고 403 NOT_ORGANIZER 와 안내 문구를 준다", async () => {
    h.resolve.mockResolvedValue({ session: null, failure: "not_organizer" });

    const { handler, res } = call();
    const response = await res;

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      code: NOT_ORGANIZER_CODE,
      error: NOT_ORGANIZER_MESSAGE,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("토큰이 무효면 종전대로 401 이다", async () => {
    h.resolve.mockResolvedValue({ session: null, failure: "invalid" });

    const { handler, res } = call();
    expect((await res).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("주최사 세션이면 핸들러로 넘긴다", async () => {
    h.resolve.mockResolvedValue({ session: { id: "u1", accountId: "a1", role: "owner" }, failure: null });

    const { handler, res } = call();
    expect((await res).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

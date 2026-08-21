import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠️ 매 테스트마다 모듈을 **새로 불러온다**. `tryRefresh` 가 진행 중인 갱신 Promise 를
 * 모듈 스코프에 500ms 캐시하기 때문에(동시 요청의 중복 갱신 방지), 앞 테스트의 갱신 결과가
 * 다음 테스트로 샌다 — 실제로 "갱신 실패" 케이스가 앞 테스트의 성공을 물려받아 통과했다.
 */
let fetchWithRefresh: typeof import("./fetchWithAuth").fetchWithRefresh;

/**
 * 🔴 access 쿠키가 **5분**이라 이 갱신이 안 걸리면 사용자는 저장할 때 편집 내용을 잃는다
 * (2026-07-31 실사고 — 대표가 실제로 잃었다).
 *
 * 화면은 로그인 상태로 보인다(`pickket_refresh`·`pickket_logged_in` 은 7일). 이미 그려진
 * 대시보드는 재검증하지 않으므로, 사용자는 **저장 버튼을 누른 그 순간 처음** 만료를 안다.
 * 그래서 "401 이 나면 조용히 갱신하고 다시 보낸다" 가 유일한 방어선이다.
 */
const ok = (body = "{}") => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const unauthorized = () => new Response('{"error":"로그인이 필요합니다"}', { status: 401, headers: { "content-type": "application/json" } });

let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(async () => {
  calls = [];
  vi.resetModules();
  ({ fetchWithRefresh } = await import("./fetchWithAuth"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** `/api/auth/refresh` 는 refreshOk 로, 나머지는 queue 순서대로 응답한다. */
function stubFetch(queue: Response[], refreshOk: boolean) {
  const rest = [...queue];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/api/auth/refresh")) {
      return new Response("{}", { status: refreshOk ? 200 : 401 });
    }
    return rest.shift() ?? ok();
  }));
}

describe("fetchWithRefresh", () => {
  it("성공하면 그대로 돌려준다 — 갱신을 부르지 않는다", async () => {
    stubFetch([ok()], true);
    const res = await fetchWithRefresh("/api/events/1", { method: "PATCH" });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.includes("/api/auth/refresh"))).toBe(false);
  });

  it("🔴 401 이면 갱신하고 **다시 보낸다** — 이게 없으면 편집 내용이 날아간다", async () => {
    stubFetch([unauthorized(), ok()], true);
    const res = await fetchWithRefresh("/api/events/1", { method: "PATCH" });
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url.includes("/api/auth/refresh"))).toHaveLength(1);
    // 원 요청 → refresh → 원 요청 재시도
    expect(calls).toHaveLength(3);
  });

  it("갱신이 실패하면 401 을 그대로 돌려준다 — 무한 재시도 금지", async () => {
    stubFetch([unauthorized()], false);
    const res = await fetchWithRefresh("/api/events/1", { method: "PATCH" });
    expect(res.status).toBe(401);
    expect(calls.filter((c) => !c.url.includes("/api/auth/refresh"))).toHaveLength(1);
  });

  /**
   * 🔴 이 함수가 존재하는 이유. `fetchWithAuth` 는 `Content-Type: application/json` 을
   * 강제해서 **FormData 업로드를 깨뜨린다**(boundary 를 브라우저가 정해야 한다).
   * 여기서 헤더를 건드리면 상세 이미지 업로드가 죽는다.
   */
  it("FormData 를 보낼 때 Content-Type 을 강제하지 않는다", async () => {
    stubFetch([ok()], true);
    const fd = new FormData();
    fd.append("file", new Blob(["x"]), "a.png");
    await fetchWithRefresh("/api/upload", { method: "POST", body: fd });
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it("호출부가 준 헤더·메서드를 보존한다", async () => {
    stubFetch([ok()], true);
    await fetchWithRefresh("/api/x", { method: "PUT", headers: { "Content-Type": "application/json" } });
    expect(calls[0]?.init?.method).toBe("PUT");
    expect((calls[0]?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("항상 쿠키를 싣는다(credentials: include)", async () => {
    stubFetch([unauthorized(), ok()], true);
    await fetchWithRefresh("/api/x", { method: "POST" });
    // 재시도까지 포함해 모든 호출이 쿠키를 실어야 한다 — 하나라도 빠지면 그 요청만 401 이다.
    expect(calls.every((c) => c.init?.credentials === "include")).toBe(true);
  });
});

/**
 * 🔴 쿠키에서 파생된 헤더 — 재시도 때 **다시 만들어야** 한다 (2026-07-31).
 *
 * 갱신은 `pickket_access` 만 새로 주는 게 아니라 **`pickket_csrf` 도 새로 발급**한다
 * (실측: refresh 응답 Set-Cookie 에 access·refresh·logged_in·csrf 넷이 함께 온다).
 * 체크인 화면은 그 CSRF 를 쿠키에서 읽어 `X-CSRF-Token` 헤더에 싣는다.
 * ⟹ `init` 객체를 그대로 재사용하면 **낡은 CSRF 로 재시도**돼 401 이 403 이 될 뿐이다.
 *    현장에서는 "빨간 X 가 다른 빨간 X 로" 바뀌는 것이라 증상이 같아 보인다.
 */
describe("fetchWithRefresh — init 을 함수로 주면 재시도 때 다시 만든다", () => {
  it("🔴 갱신으로 CSRF 가 회전해도 재시도가 새 값을 싣는다", async () => {
    let csrf = "old-token";
    // 갱신이 성공하면 쿠키가 회전한 것처럼 값을 바꾼다.
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes("/api/auth/refresh")) {
        csrf = "new-token";
        return new Response("{}", { status: 200 });
      }
      const sent = (init?.headers as Record<string, string>)?.["X-CSRF-Token"];
      // 낡은 토큰이면 v2 가 403 으로 튕긴다(실제 동작 모사).
      if (sent !== csrf) return new Response("{}", { status: 403 });
      return csrf === "new-token" ? ok() : unauthorized();
    }));

    const res = await fetchWithRefresh("https://api.pickket.kr/api/v1/tickets/validate-qr", () => ({
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
    }));

    expect(res.status, "낡은 CSRF 로 재시도하면 403 이 된다").toBe(200);
    const sentTokens = calls
      .filter((c) => !c.url.includes("/api/auth/refresh"))
      .map((c) => (c.init?.headers as Record<string, string>)?.["X-CSRF-Token"]);
    expect(sentTokens, "재시도가 갱신 후 값을 실어야 한다").toEqual(["old-token", "new-token"]);
  });

  it("객체로 주던 기존 호출부는 그대로 동작한다 (하위호환)", async () => {
    stubFetch([unauthorized(), ok()], true);
    const res = await fetchWithRefresh("/api/events/1", { method: "PATCH" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("init 함수는 시도마다 호출된다 — 한 번 만들어 캐시하지 않는다", async () => {
    let built = 0;
    stubFetch([unauthorized(), ok()], true);
    await fetchWithRefresh("/api/events/1", () => {
      built += 1;
      return { method: "PATCH" };
    });
    expect(built, "첫 시도 + 재시도 = 2회 만들어져야 한다").toBe(2);
  });

  it("성공하면 한 번만 만든다 (불필요한 재생성 없음)", async () => {
    let built = 0;
    stubFetch([ok()], true);
    await fetchWithRefresh("/api/events/1", () => {
      built += 1;
      return { method: "PATCH" };
    });
    expect(built).toBe(1);
  });
});

describe("tryRefresh — 동시 갱신 보호가 노출된다", () => {
  it("🔴 동시에 여러 번 불러도 /api/auth/refresh 는 한 번만 나간다", async () => {
    // v2 는 갱신할 때마다 refresh 토큰을 회전시킨다 — 동시 호출은 뒤엣것이 반드시 401 이다.
    // 그래서 체크인 재시도도 이 싱글턴을 타야 하고, 직접 fetch 를 부르면 안 된다.
    const { tryRefresh } = await import("./fetchWithAuth");
    stubFetch([], true);
    const [a, b, c] = await Promise.all([tryRefresh(), tryRefresh(), tryRefresh()]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(calls.filter((x) => x.url.includes("/api/auth/refresh"))).toHaveLength(1);
  });
});

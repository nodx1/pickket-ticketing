import { describe, expect, it } from "vitest";
import { buildCsp } from "./proxy";

/**
 * 🔴 2026-08-10 실장애 — 데스크탑 결제가 통째로 멈췄다.
 *
 * 나이스 인증이 끝나면 SDK 가 `nicepaySubmit()` 으로 payForm 을 **ReturnURL 로 POST**
 * 한다. 그 주소는 `https://api.pickket.kr/...`(v2)이고 `'self'`(go.pickket.kr)가 아니다.
 * `form-action` 에 그 오리진이 없으면 브라우저가 폼 전송을 차단하고, SDK 의 하드콜이
 * 그 자리에서 죽어 오버레이("Please, wait...")가 영원히 남는다.
 *
 * ⚠️ **모바일은 멀쩡했다** — 리다이렉트라 우리 페이지가 POST 하지 않는다.
 *    그래서 "웹만 안 된다" 는 민원이 됐고, 서버 로그에는 아무것도 안 남았다
 *    (요청이 브라우저에서 막혀 서버까지 오지 않는다).
 *
 * ⚠️ `connect-src` 에는 처음부터 `*.pickket.kr` 가 있었다. **폼 전송은 별개 지시어**라
 *    따라오지 않는다. 그 착각이 이 결함의 원인이다.
 */
function directive(csp: string, name: string): string {
  const found = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  return found ?? "";
}

describe("🔴 CSP — 나이스 결제 폼 전송", () => {
  for (const isDev of [false, true]) {
    it(`form-action 이 v2(api.pickket.kr)로의 POST 를 허용한다 (isDev=${isDev})`, () => {
      const fa = directive(buildCsp("n0nce", isDev), "form-action");
      expect(fa, "form-action 지시어가 없다").not.toBe("");
      expect(
        fa.includes("https://*.pickket.kr") || fa.includes("https://api.pickket.kr"),
        "🔴 ReturnURL(api.pickket.kr)로 폼을 못 보내면 데스크탑 결제가 통째로 멈춘다",
      ).toBe(true);
    });
  }

  it("🔴 connect-src 가 허용하는 pickket 오리진을 form-action 도 허용한다", () => {
    // 두 지시어가 갈리면 "연결은 되는데 폼만 막히는" 상태가 된다 — 그게 이 사고였다.
    const csp = buildCsp("n0nce", false);
    const conn = directive(csp, "connect-src");
    const fa = directive(csp, "form-action");
    if (conn.includes("https://*.pickket.kr")) {
      expect(fa, "connect-src 만 열려 있고 form-action 이 닫혀 있다").toContain(
        "https://*.pickket.kr",
      );
    }
  });

  it("나이스 결제창 오리진도 유지된다 (goPay 가 그쪽으로 POST 한다)", () => {
    const fa = directive(buildCsp("n0nce", false), "form-action");
    expect(fa).toContain("https://*.nicepay.co.kr");
  });
});

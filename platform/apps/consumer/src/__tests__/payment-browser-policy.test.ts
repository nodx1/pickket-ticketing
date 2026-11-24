import { describe, it, expect, vi } from "vitest";

// 미들웨어 본체가 next-intl 미들웨어를 불러온다 — CSP 조립 함수만 시험하므로 막아 둔다.
vi.mock("next-intl/middleware", () => ({ default: () => () => undefined }));
import fs from "node:fs";
import path from "node:path";
import { buildCspHeader } from "@/middleware";

// 2026-11-24 나이스 운영 상점 실결제 시험에서 결제를 끝까지 막던 브라우저 정책 2가지의 회귀 방지.

function directive(csp: string, name: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
}

describe("결제 브라우저 정책", () => {
  for (const isDev of [true, false]) {
    it(`form-action 이 v2(인증 결과 ReturnURL) 오리진으로의 POST 를 허용한다 (isDev=${isDev})`, () => {
      const api = isDev ? "http://localhost:8021" : "https://api.pickket.kr";
      const fa = directive(buildCspHeader("n0nce", api, "", isDev, false), "form-action");
      expect(fa).not.toBe("");
      expect(fa.split(/\s+/)).toContain(api);
      expect(fa).toContain("https://*.nicepay.co.kr");
    });
  }

  it("Cross-Origin-Opener-Policy 가 카드사 인증 팝업을 끊지 않는다(same-origin-allow-popups)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../next.config.ts"), "utf8");
    const values = [...src.matchAll(/key:\s*"Cross-Origin-Opener-Policy",\s*value:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toBe("same-origin-allow-popups");
  });
});

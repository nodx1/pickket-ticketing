/**
 * 🔴 결제 전에 「언제·어디서」를 보여준다 (2026-08-01 감사 P1-①).
 *
 * 체크아웃 1~3단계에 행사 일시·장소가 **없었다**. 이 대회는 주중권(목~금)/주말권(토~일)로
 * 날짜가 갈리는데, 잘못 고른 걸 **결제가 끝난 뒤에** 알게 되는 구조였다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatWhenWhere } from "./event-when-where";

describe("formatWhenWhere", () => {
  it("🔴 일시와 장소를 한 줄로 — KST 로 읽는다", () => {
    // 2026-08-20T07:00 KST = 2026-08-19T22:00Z
    const out = formatWhenWhere("2026-08-19T22:00:00Z", "포천힐스CC");
    expect(out).toContain("2026");
    expect(out).toContain("8월 20일");
    expect(out).toContain("포천힐스CC");
    expect(out, "요일이 없으면 주중/주말권을 못 가린다").toMatch(/\(목\)/);
  });

  it("🔴 UTC 로 읽으면 날짜가 하루 밀린다 — 타임존을 고정했는지", () => {
    // 이 시각은 UTC 로는 8/19, KST 로는 8/20 이다. 주중권/주말권 경계가 걸린 날짜.
    expect(formatWhenWhere("2026-08-19T22:00:00Z", null)).toContain("8월 20일");
    expect(formatWhenWhere("2026-08-19T22:00:00Z", null)).not.toContain("8월 19일");
  });

  it("장소만 있으면 장소만", () => {
    expect(formatWhenWhere(null, "포천힐스CC")).toBe("포천힐스CC");
  });

  it("일시만 있으면 일시만 (구분자를 남기지 않는다)", () => {
    const out = formatWhenWhere("2026-08-19T22:00:00Z", null);
    expect(out).not.toContain("·");
    expect(out.length).toBeGreaterThan(0);
  });

  it("🔴 값이 없으면 빈 문자열 — '미정' 같은 말을 지어내지 않는다", () => {
    for (const [d, v] of [[null, null], [undefined, undefined], ["", "  "]] as const) {
      expect(formatWhenWhere(d, v)).toBe("");
    }
  });

  it("🔴 날짜가 깨져도 던지지 않는다 — 부가 정보 한 줄로 결제를 막지 않는다", () => {
    expect(() => formatWhenWhere("not-a-date", "포천힐스CC")).not.toThrow();
    expect(formatWhenWhere("not-a-date", "포천힐스CC")).toBe("포천힐스CC");
  });
});

describe("체크아웃 배선", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "app", "(public)", "e", "[eventSlug]", "checkout", "_components", "checkout-ticket-step.tsx"),
    "utf8",
  );

  it("§0 대상 파일을 실제로 읽었다", () => {
    expect(src.length).toBeGreaterThan(2000);
  });

  it("🔴 1단계가 일시·장소를 받아 그린다", () => {
    expect(src, "prop 을 안 받으면 값이 도달하지 못한다").toMatch(/startsAt\?: string \| null;/);
    expect(src).toMatch(/venueName\?: string \| null;/);
    expect(src, "계산만 하고 렌더하지 않으면 화면은 그대로다").toContain("{eventWhenWhere}");
    expect(src).toMatch(/formatWhenWhere\(event\.startsAt, event\.venueName\)/);
  });
});

describe("결제 화면 제목", () => {
  const BASE = path.join(__dirname, "..", "..", "app", "(public)", "e", "[eventSlug]", "checkout");
  const PAGES: Array<[string, string]> = [
    ["page.tsx", "1단계 · 티켓 선택"],
    ["details/page.tsx", "2단계 · 정보 입력"],
    ["payment/page.tsx", "3단계 · 결제"],
  ];

  it("🔴 세 단계 모두 단계가 보이는 제목을 낸다", () => {
    for (const [rel, title] of PAGES) {
      const src = fs.readFileSync(path.join(BASE, rel), "utf8");
      expect(src, `${rel} 에 generateMetadata 가 없다 — 루트 기본 제목이 나온다`).toContain("generateMetadata");
      expect(src, `${rel} 의 제목이 단계를 안 보여준다`).toContain(title);
    }
  });

  it("🔴 브랜드를 또 붙이지 않는다 — 루트 template 이 붙인다", () => {
    for (const [rel] of PAGES) {
      const src = fs.readFileSync(path.join(BASE, rel), "utf8");
      const meta = src.slice(src.indexOf("generateMetadata"), src.indexOf("export default"));
      expect(meta, `${rel}: — PICKKET.GO — PICKKET.GO 가 된다`).not.toContain("PICKKET.GO");
    }
  });

  it("구매 절차 화면은 색인하지 않는다", () => {
    for (const [rel] of PAGES) {
      const src = fs.readFileSync(path.join(BASE, rel), "utf8");
      expect(src).toMatch(/robots:\s*\{\s*index:\s*false/);
    }
  });
});

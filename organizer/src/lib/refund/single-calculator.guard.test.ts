import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 🔴 환불 금액을 만지는 곳이 **한 계산기만** 쓰게 고정한다 (2026-07-31 코덱스 감사).
 *
 * ## 무슨 일이 있었나 — "3곳" 이라 보고했는데 4곳이었다
 * 오후에 환불 계산을 `cancellation-fee.ts` 로 통일하면서 진입점을 **3곳** 배선하고
 * "표시=지급이 성립한다" 고 보고했다. 그런데 **주문 상세 화면**이 빠져 있었다.
 * 그 화면은 여전히 옛 `calculator.ts`(시작시각·Math.floor·별도 기본표)와
 * 빈 저장소(`event_refund_policies`, prod 0행)를 보고 있었다.
 *
 *     주문 25,000원 · 기본단계 · D-5
 *       주문 상세 화면   80% = 20,000원   ← 주최자가 보고 승인하는 숫자
 *       실제 환불 라우트 70% = 17,500원   ← 고객이 받는 금액
 *
 * 그 파일 주석에는 **"환불 API 와 동일 헬퍼로 조회해 표시 예상액=실제 처리액 일치"** 라고
 * 적혀 있었다. 한쪽만 옮긴 순간 **주석이 거짓말이 됐고, 아무도 안 깨졌다.**
 *
 * ⟹ 사람이 "다 옮겼나" 를 기억하는 방식은 실패한다. 여기서 소스를 훑어 막는다.
 */
const SRC = path.join(process.cwd(), "src");

/** 옛 계산기 — 시작시각 기준 · `Math.floor` · 자체 기본표. 새 코드가 부르면 안 된다. */
const LEGACY_CALC = /from ["']@\/lib\/refund\/calculator["']/;
/** 빈 저장소를 읽는 헬퍼 — v2 `event_refund_policies` 는 쓰는 화면이 없어 항상 비어 있다. */
const EMPTY_STORE = /\bgetEventRefundRules\b/;

/**
 * 주석을 걷어낸 소스. 🔴 이게 없으면 **"종전엔 getEventRefundRules 였다"** 같은
 * 설명 주석까지 결함으로 잡는다(실제로 잡혔다). 가드가 거짓 양성을 내면
 * 다음 사람이 가드를 끄거나 무시하게 된다 — 그게 가드를 죽이는 가장 흔한 경로다.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 죽은 저장소(`event_refund_policies`)의 **전용 CRUD 라우트**.
 * 이 라우트가 그 저장소를 읽는 것은 정의상 맞다 — 금액 계산에 쓰지만 않으면 된다.
 * ⚠️ 이 저장소는 쓰는 화면이 없어 prod 0행이다. 대회 후 폐기 검토 대상.
 */
const DEAD_STORE_CRUD = "app/api/events/[eventId]/refund-policy/route.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(full);
  }
  return out;
}

describe("환불 계산기는 하나다", () => {
  const files = walk(SRC).filter((f) => !f.endsWith("lib/refund/calculator.ts") && !f.endsWith("lib/refund/policy.ts"));

  it("스캔 대상이 실제로 있다 — 경로가 틀리면 이 가드는 조용히 통과한다", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("🔴 옛 `calculator.ts` 를 import 하는 곳이 없다", () => {
    const bad = files.filter((f) => LEGACY_CALC.test(stripComments(readFileSync(f, "utf8")))).map((f) => path.relative(SRC, f));
    expect(
      bad,
      "옛 계산기는 **행사 시작시각 · Math.floor · 별도 기본표**를 쓴다. " +
        "`lib/refund/cancellation-fee.ts` 를 쓸 것:\n  " + bad.join("\n  "),
    ).toEqual([]);
  });

  it("🔴 빈 저장소(`getEventRefundRules`)를 읽는 곳이 없다", () => {
    const bad = files
      .filter((f) => EMPTY_STORE.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => path.relative(SRC, f))
      .filter((rel) => rel !== DEAD_STORE_CRUD);
    expect(
      bad,
      "v2 `event_refund_policies` 는 **쓰는 화면이 없어 prod 0행**이다. 읽으면 항상 " +
        "하드코딩 기본값으로 떨어진다. `getEventForRefund`(= events.cancellation_fee_tiers)를 쓸 것:\n  " +
        bad.join("\n  "),
    ).toEqual([]);
  });

  it("환불 금액을 만드는 곳은 전부 새 계산기를 쓴다 — 4곳(주최자환불·구매자미리보기·구매자신청·주문상세)", () => {
    const users = files.filter((f) => /calculateCancellationRefund/.test(stripComments(readFileSync(f, "utf8"))));
    expect(users.length).toBeGreaterThanOrEqual(4);
  });
});

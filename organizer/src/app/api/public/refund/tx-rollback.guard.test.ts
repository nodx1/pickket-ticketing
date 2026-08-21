import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 🔴 구매자 즉시환불 트랜잭션이 **롤백 없이 반납되지 않게** 고정한다 (2026-08-01 배포 검수).
 *
 * ## 무슨 일이 있었나
 * 즉시환불 도입 커밋(58adc964)이 `try { BEGIN ... } finally { release }` 로만 감쌌다.
 * BEGIN~COMMIT 사이에서 예외가 나면 **롤백 없이 커넥션이 풀로 반납된다.**
 * `pg` 는 반납 시 자동 롤백을 하지 않는다.
 *
 * 로컬 실증(pg 8.20, `max: 1`):
 *
 *     같은 커넥션 재사용 : 예 (pid 807)
 *     미커밋 쓰기 잔존   : 🔴 남음(1행)      ← 롤백이 안 됐다
 *     커넥션 상태        : active
 *
 * 다음에 들어온 **무관한 요청이 그 열린 트랜잭션 안에서 돈다.** 게다가 이 경로는
 * `SELECT ... FOR UPDATE` 로 go `orders` 행을 잠그므로, **그 주문의 후속 처리가 통째로 멈춘다.**
 * 돈이 나가는 공개 경로에서 대회 중에 터지면 원인을 찾기 어려운 종류다.
 *
 * ## 왜 소스 가드인가
 * 이 결함은 **DB 레벨 예외가 나야** 드러난다. 단위 테스트는 그 지점을 지나가지 않으므로
 * 전부 초록으로 통과했다(실제로 2439 passed 였다). 막아야 하는 건 **구조**다.
 *
 * ## 정본 패턴
 * `src/lib/payment/webhook.ts` — `catch { ROLLBACK; throw } finally { release }`.
 */
const ROUTE = path.join(process.cwd(), "src/app/api/public/refund/route.ts");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("즉시환불 트랜잭션 정리", () => {
  const code = stripComments(readFileSync(ROUTE, "utf8"));

  it("🔴 BEGIN 을 쓰면 catch 에서 ROLLBACK 한다 — 없으면 커넥션이 열린 채 반납된다", () => {
    expect(code, "이 경로에 트랜잭션이 없어졌다면 이 가드를 재검토할 것").toMatch(
      /client\.query\("BEGIN"\)/,
    );
    expect(
      /catch[\s\S]{0,400}?client\.query\("ROLLBACK"\)/.test(code),
      "`try { BEGIN … } finally { release }` 만 두면 예외 시 롤백 없이 반납된다. " +
        "`lib/payment/webhook.ts` 처럼 catch 에서 ROLLBACK 하고 다시 throw 할 것.",
    ).toBe(true);
  });

  it("🔴 원래 예외를 삼키지 않는다 — 삼키면 500 대신 조용한 성공이 된다", () => {
    expect(code).toMatch(/catch \(txErr: unknown\)[\s\S]{0,900}?throw txErr;/);
  });

  it("🔴 트랜잭션 개폐를 상태로 추적한다 — COMMIT 뒤 ROLLBACK 은 경고만 남기고 누출을 가린다", () => {
    // COMMIT 이후 구간(v2 집행·go 투영)이 같은 try 안에 있다. 플래그가 없으면 이미 닫힌
    // 트랜잭션에 ROLLBACK 을 쏘게 되고, postgres 는 "no transaction in progress" 경고만
    // 내므로 **진짜 누출과 구분이 안 된다.**
    expect(code).toMatch(/let txOpen = false;/);
    expect(code).toMatch(/if \(txOpen\)/);
    // BEGIN·COMMIT·이른 ROLLBACK 각각에서 플래그가 갱신되어야 한다.
    expect((code.match(/txOpen = true;/g) ?? []).length, "BEGIN 직후 1회").toBe(1);
    expect(
      (code.match(/txOpen = false;/g) ?? []).length,
      "선언 1 + 이른 ROLLBACK 2 + COMMIT 1 + catch 1 = 5",
    ).toBe(5);
  });

  it("이른 반환(404·409)도 ROLLBACK 후 플래그를 내린다", () => {
    // `if (locked.rows.length === 0)` / `if (dup.rows.length > 0)` 두 분기.
    const earlyReturns = code.match(/client\.query\("ROLLBACK"\);\s*txOpen = false;/g) ?? [];
    expect(earlyReturns.length, "주문 없음 · 중복 신청 두 분기").toBe(2);
  });

  it("커넥션은 어떤 경로에서도 반납된다", () => {
    expect(code).toMatch(/finally \{\s*client\.release\(\);\s*\}/);
  });
});

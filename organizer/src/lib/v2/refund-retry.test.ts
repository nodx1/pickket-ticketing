import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 🔴 돈이 나가는 호출은 자동 재시도하지 않는다.
 *
 * v2 의 멱등 캐시는 **성공 응답만** 저장하고 선점 락이 없다. 환불에는 DB 유니크 제약도
 * 없어(한 주문에 여러 환불 행이 정상) in-flight 중복을 막을 장치가 없다.
 * PG 지연으로 클라가 10초 타임아웃에 abort 해도 서버는 실행 중인데, 재시도가 캐시 미스로
 * 재진입해 **같은 델타를 또 집행**한다(10,000원 지시 → 20,000원 환불).
 *
 * 소스 검사인 이유: 재시도는 HTTP 계층 옵션이라 단위 호출로는 관측되지 않는다.
 */
describe("환불 호출 재시도 정책", () => {
  const src = readFileSync(
    join(process.cwd(), "src/lib/v2/commerce-client.ts"),
    "utf8",
  );

  function bodyOf(fnName: string): string {
    const start = src.indexOf(`export function ${fnName}(`);
    expect(start, `${fnName} 정의를 찾지 못했다`).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport function ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  it("refundOrder 는 retries: 0 을 명시한다", () => {
    expect(bodyOf("refundOrder")).toMatch(/retries:\s*0/);
  });

  it("refundOrderItems 도 retries: 0 을 명시한다", () => {
    expect(bodyOf("refundOrderItems")).toMatch(/retries:\s*0/);
  });

  it("환불 호출이 기본 재시도(2회)를 그대로 쓰지 않는다", () => {
    // 기본값에 기대면 commerce-client 의 전역 정책이 바뀔 때 조용히 재시도가 살아난다.
    for (const fn of ["refundOrder", "refundOrderItems"]) {
      expect(bodyOf(fn).includes("opts)"), `${fn} 이 기본 opts 를 그대로 넘긴다`).toBe(false);
    }
  });
});

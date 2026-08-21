import { afterEach, describe, expect, it, vi } from "vitest";

import { isProdRuntime } from "./runtime";
import { testFlagLeakIssue } from "./test-flag-leak";

/**
 * `isProdRuntime()` 의 **동작** 고정.
 *
 * 짝인 `runtime.guard.test.ts` 는 "인라인 복제가 없는가"(구조)만 본다 —
 * 판정 자체가 뒤집혀도 그 가드는 초록이다. 이 파일이 판정을 잡는다.
 * (검증 원칙 #3 — 구조 검사와 동작 검사는 다른 것을 증명한다)
 *
 * `process.env` 를 직접 읽는 함수라 `vi.stubEnv` 로 주입한다.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

function withEnv(nodeEnv: string | undefined, playwright: string | undefined): boolean {
  vi.stubEnv("NODE_ENV", nodeEnv as string);
  vi.stubEnv("PLAYWRIGHT_TEST", playwright as string);
  return isProdRuntime();
}

describe("isProdRuntime", () => {
  it("배포 프로덕션 → true (쿠키 secure · 결제 self-complete 차단이 켜진다)", () => {
    expect(withEnv("production", undefined)).toBe(true);
  });

  it("🔴 프로덕션 + 플래그 → false — 이 조합이 배포 이미지에 새면 결제 차단이 풀린다", () => {
    expect(withEnv("production", "1")).toBe(false);
  });

  it.each(["development", "test"])("%s → false", (nodeEnv) => {
    expect(withEnv(nodeEnv, undefined)).toBe(false);
  });

  /**
   * 🔴 우회는 정확히 "1" 만이어야 한다.
   * 느슨하게 truthy 판정으로 바뀌면 CapRover 에 `PLAYWRIGHT_TEST=true` 를 넣은 것만으로
   * 결제 차단이 풀린다 — 부팅 가드(`test-flag-leak.ts`)도 `!== "1"` 을 전제로 하므로
   * 두 판정이 갈리면 **가드는 통과하는데 차단은 풀린 상태**가 만들어진다.
   */
  it.each(["true", "TRUE", "0", "yes", "on", " 1", "1 ", "01"])(
    'PLAYWRIGHT_TEST="%s" 는 우회가 아니다 — 프로덕션이면 여전히 true',
    (raw) => {
      expect(withEnv("production", raw)).toBe(true);
    },
  );

  it("플래그만 있고 프로덕션이 아니면 false — 로컬 dev 가 프로덕션으로 오인되지 않는다", () => {
    expect(withEnv("development", "1")).toBe(false);
  });
});

/**
 * 🔴 두 판정의 결합 — 갈라지면 "가드는 통과하는데 차단만 풀린" 구멍이 생긴다.
 *
 * 종전엔 `isProdRuntime()` 과 `testFlagLeakIssue()` 가 각자 `"1"` 을 적고 있었고, 그 위험은
 * 주석으로만 적혀 있었다. 지금은 둘 다 `isTestFlagEnabled()` 를 쓴다 — **갈라질 수가 없다.**
 * 이 검사는 그 결합이 유지되는지 본다(주석은 리팩터링에 안 따라오지만 이 검사는 따라온다).
 */
describe("우회 판정과 유출 가드가 같은 기준을 쓴다", () => {
  const RAWS = [undefined, "", "0", "1", "true", "TRUE", "yes", "on", " 1", "1 ", "01"];

  it.each(RAWS)("PLAYWRIGHT_TEST=%o — 우회 여부와 가드 발화 여부가 항상 일치한다", (raw) => {
    const bypasses = !withEnv("production", raw); // isProdRuntime()==false ⟺ 보안 제약 완화
    const guardFires = testFlagLeakIssue({ app: "pickket-organizer", playwrightTest: raw }) !== null;
    expect(
      guardFires,
      `우회=${bypasses} 인데 가드=${guardFires} — 어긋나면 차단만 풀린 배포가 조용히 통과한다`,
    ).toBe(bypasses);
  });
});

/**
 * 테스트 플래그 유출 가드 (2026-07-30).
 *
 * `proxy.ts` 전역 리미터까지 우회 대상에 넣으면서 go 계층 레이트리밋이 0 이 됐다.
 * 그 우회 확대의 **전제 조건**이 이 가드다 — 플래그가 배포 이미지에 못 새게 막는다.
 *
 * 순수 판정 함수(`testFlagLeakIssue`)만 검사한다. `assertNoTestFlagLeak` 는 이 판정에
 * `getBuildInfo()` + `process.env` 를 꽂고 throw 하는 얇은 껍데기다.
 */
import { describe, expect, it } from "vitest";
import { testFlagLeakIssue } from "./test-flag-leak";

describe("배포 이미지 테스트 플래그 유출 판정", () => {
  it("배포 이미지 + PLAYWRIGHT_TEST=1 → 위반", () => {
    const issue = testFlagLeakIssue({ app: "pickket-organizer", playwrightTest: "1" });
    expect(issue).toBeTruthy();
    expect(issue).toContain("pickket-organizer");
    expect(issue, "무엇이 꺼지는지 알려야 조치가 된다").toMatch(/레이트리밋/);
  });

  it("🔴 로컬 프로덕션 빌드(app=\"local\") + PLAYWRIGHT_TEST=1 → 통과", () => {
    // 우리 라이브 검증은 `npm run build && npm run start` 라 NODE_ENV=production 이다.
    // 여기서 막히면 검증 워크플로 자체가 죽는다 — 이 케이스를 지키는 게 이 가드의 절반이다.
    expect(testFlagLeakIssue({ app: "local", playwrightTest: "1" })).toBeNull();
  });

  it("배포 이미지지만 플래그 없음 → 통과", () => {
    expect(testFlagLeakIssue({ app: "pickket-organizer", playwrightTest: undefined })).toBeNull();
    expect(testFlagLeakIssue({ app: "pickket-organizer", playwrightTest: "0" })).toBeNull();
    expect(testFlagLeakIssue({ app: "pickket-organizer", playwrightTest: "" })).toBeNull();
  });

  it("`.build-info.json` 이 깨져 app 이 빈 문자열이어도 배포로 본다(fail-closed)", () => {
    // 파일이 아예 없으면 FALLBACK 이 "local" 이지만, 파싱은 됐는데 app 키가 없으면 "" 다
    // (`build-info.ts` 의 파싱 분기). 모르는 상태에서 플래그까지 켜져 있으면 막는 쪽이 맞다.
    expect(testFlagLeakIssue({ app: "", playwrightTest: "1" })).toBeTruthy();
  });
});

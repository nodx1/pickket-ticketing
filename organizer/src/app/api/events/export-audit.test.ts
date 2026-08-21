import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * 🔴 개인정보 CSV 내려받기에 감사 기록이 붙어 있는지 소스로 고정한다 (2026-07-29 감사).
 *
 * 이 네 라우트는 참석자 이름·이메일·전화, 주문 구매자 정보를 **평문 CSV** 로 내보낸다.
 * 종전에는 누가 언제 몇 바이트를 받아갔는지 아무 기록이 없어, 계정 탈취나 내부자
 * 오남용이 있어도 사후 추적이 불가능했다. 권한(`withRole("organizer")`) 자체는 정상이다 —
 * 문제는 "정당한 권한으로 받아간 것"조차 남지 않았다는 점이다.
 *
 * 모듈을 import 해서 확인하지 않는 이유: 라우트는 DB·세션·v2 클라이언트 의존이 딸려 와
 * 단위 테스트가 닿지 못한다. 이 리포에서 배선 검사가 세 번 헛돈 전례가 있어
 * **주석을 걷어낸 본문**에서 실제 호출을 찾는다.
 */
const ROUTES = [
  ["참석자", "attendees/export"],
  ["주문", "orders/export"],
  ["리포트", "reports/export"],
  ["체크인", "check-in/export"],
] as const;

async function routeBody(rel: string) {
  const source = await readFile(
    new URL(`./[eventId]/${rel}/route.ts`, import.meta.url),
    "utf8",
  );
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("PII CSV 내려받기 감사 기록", () => {
  it.each(ROUTES)("%s export 가 logAudit 을 호출한다", async (_label, rel) => {
    expect(await routeBody(rel)).toMatch(/logAudit\(\{/);
  });

  it.each(ROUTES)('%s export 가 action: "export" 로 남긴다', async (_label, rel) => {
    expect(await routeBody(rel)).toMatch(/action:\s*"export"/);
  });

  it.each(ROUTES)("%s export 가 누가 받아갔는지 남긴다(userId·accountId)", async (_label, rel) => {
    const code = await routeBody(rel);
    expect(code).toMatch(/userId:\s*session\.id/);
    expect(code).toMatch(/accountId:\s*session\.accountId/);
  });

  it.each(ROUTES)("%s export 가 어느 이벤트인지 남긴다", async (_label, rel) => {
    expect(await routeBody(rel)).toMatch(/recordId:\s*params\.eventId/);
  });

  it.each(ROUTES)("🔴 %s export 는 감사 실패로 다운로드를 막지 않는다(void 호출)", async (_label, rel) => {
    // await 로 바꾸면 v2 감사 엔드포인트 장애가 곧 다운로드 실패가 된다.
    // logAudit 은 내부에서 실패를 삼키도록 설계돼 있으므로 기다릴 이유가 없다.
    expect(await routeBody(rel)).toMatch(/void\s+logAudit\(/);
  });

  it("권한 게이트는 그대로 organizer 이상이다 — 감사 추가가 접근을 넓히지 않았다", async () => {
    for (const [, rel] of ROUTES) {
      expect(await routeBody(rel)).toMatch(/withRole<Params>\("organizer"/);
    }
  });
});

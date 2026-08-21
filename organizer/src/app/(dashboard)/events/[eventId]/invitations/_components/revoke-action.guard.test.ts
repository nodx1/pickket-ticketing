import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 🔴 초대권 **회수 버튼** 가드 (2026-07-31).
 *
 * ## 배경
 * `POST /api/events/[eventId]/invitations/[invitationId]` 에 `action:"revoke"` 가 있는데
 * **화면 어디에서도 부르지 않았다.** 잘못 보낸 초대권을 주최자가 회수할 방법이 없어
 * 개발자가 API 를 직접 때려야 했다 — 대회 당일엔 불가능하다.
 *
 * ## 왜 소스 문자열 검사인가
 * 이 화면에는 렌더 테스트가 없다(jsdom·testing-library 미도입).
 * 렌더 테스트를 세워도 "확인 없이 즉시 회수되는가" 같은 **위험 배선**은
 * 클릭 시나리오를 다 짜야 잡힌다. 그래서 **위험 패턴 자체를 금지**한다.
 *
 * ⚠️ 이 가드는 "회수가 올바로 동작한다" 를 증명하지 않는다.
 *    **되돌릴 수 없는 동작이 맨손으로 노출되는 것**을 막을 뿐이다.
 */

const FILE = join(
  process.cwd(),
  "src/app/(dashboard)/events/[eventId]/invitations/_components/bulk-invitations-client.tsx",
);

function src(): string {
  return readFileSync(FILE, "utf8");
}

/** 주석을 제거한다 — 설명 문구가 검사에 걸리면 안 된다. */
function code(): string {
  return src()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("초대권 회수 버튼", () => {
  it("🔴 회수 API 를 실제로 호출한다 — 라우트만 있고 화면이 안 부르던 결함", () => {
    const s = code();
    expect(s).toContain('action: "revoke"');
    expect(s).toMatch(/\/api\/events\/\$\{eventId\}\/invitations\/\$\{[^}]+\}/);
  });

  it("🔴 확인 다이얼로그를 거친다 — 되돌릴 수 없는 동작이다", () => {
    // 버튼 onClick 이 곧바로 fetch 를 부르면 오클릭 한 번에 링크가 죽는다.
    const s = code();
    expect(s).toContain("revokeTarget");
    // 회수 호출은 확인 핸들러(doRevoke) 안에만 있어야 한다.
    const handler = /async function doRevoke\(\)[\s\S]*?\n  \}/.exec(s);
    expect(handler, "doRevoke 핸들러를 찾지 못했다").not.toBeNull();
    expect(handler![0]).toContain('action: "revoke"');
  });

  it("🔴 확인 문구가 결과를 명시한다 — '링크 사용 불가' 와 '되돌릴 수 없다'", () => {
    // 주석이 아니라 화면에 나가는 문자열이어야 한다.
    const s = code();
    expect(s).toMatch(/사용 불가/);
    expect(s).toMatch(/되돌릴 수 없습니다/);
  });

  it("🔴 재진입 가드가 있다 — 외부 상태를 바꾸는 동작이다", () => {
    const handler = /async function doRevoke\(\)[\s\S]*?\n  \}/.exec(code());
    expect(handler![0]).toMatch(/if \(!target \|\| revoking\) return;/);
  });

  it("🔴 이미 회수됨·입장완료 행은 버튼을 비활성화한다", () => {
    // 서버도 409 로 막지만, 누를 수 있게 두면 주최자는 '실패'를 결함으로 읽는다.
    const s = code();
    expect(s).toMatch(/disabled=\{[\s\S]*?revoked[\s\S]*?checked_in[\s\S]*?\}/);
  });

  it("실패 사유를 삼키지 않는다 — '이미 회수됨'과 '입장 완료'는 조치가 다르다", () => {
    const handler = /async function doRevoke\(\)[\s\S]*?\n  \}/.exec(code());
    expect(handler![0]).toMatch(/res\.error/);
  });

  it("성공 후 목록을 다시 읽는다 — 화면이 옛 상태로 남으면 두 번 누른다", () => {
    const handler = /async function doRevoke\(\)[\s\S]*?\n  \}/.exec(code());
    expect(handler![0]).toContain("loadList()");
  });

  it("ConfirmDialog 에 pending 을 넘긴다 — 확인 버튼 더블클릭 방어", () => {
    expect(code()).toMatch(/pending=\{revoking !== null\}/);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 상세 안내 이미지 편집기의 **배선** 가드.
 *
 * 🔴 왜 필요한가 — 실측한 사각지대
 * 순수 로직은 `detail-image-order.test.ts` 16건으로 지켜진다. 그런데 **컴포넌트가 그것을
 * 실제로 쓰는지**는 아무것도 증명하지 않았다. 아래 네 뮤테이션이 vitest 2027건 + tsc 를
 * **전부 통과**했다(2026-07-30 실측):
 *
 *   A `pendingSection.current = section` → `= "intro"`   누른 그룹 무시 = 결함 (a) 재발
 *   B `uploadFiles(files, pendingSection.current)` → `"intro"`
 *   C `{left > 0 ? (` → `{true ? (`                      가득 찬 그룹에 버튼 유지 = (b) 재발
 *   D `moveWithinSection(...)` → 전체 배열 스왑            섹션 경계 넘김 = (c) 재발
 *
 * ⚠️ **이것은 구조 검사이고 동작 검사가 아니다.** 소스에 그 문장이 있다는 것은
 *    "런타임에 그렇게 동작한다" 를 증명하지 않는다(오늘 UI세션에 같은 말을 했다).
 *    동작 검증은 `specs/e2e/ui-forms/detail-image-groups.spec.ts` 가 하며,
 *    그 실행은 v2 의 `AUTH_TEST_BYPASS_ENABLED` 와 전용 go 테스트 DB 가 필요해
 *    **현재 미실행**이다. 그 전제가 갖춰지면 이 가드는 보조가 된다.
 *
 * vitest 환경이 `environment: "node"` 라 DOM 렌더 테스트는 불가하다(설정 변경이 필요).
 */

const EDITOR = path.join(
  new URL("../../", import.meta.url).pathname,
  "app/(dashboard)/events/[eventId]/settings/_components/detail-image-editor.tsx",
);

/** 주석을 걷어낸 본문 — "종전에는 …" 이력 기록이 판정에 섞이면 안 된다. */
function code(): string {
  return fs
    .readFileSync(EDITOR, "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("상세 이미지 편집기 배선", () => {
  it("§0 대상 파일이 실재하고 본문이 비어 있지 않다", () => {
    expect(fs.existsSync(EDITOR)).toBe(true);
    expect(code().length).toBeGreaterThan(2000);
  });

  it("§0-A 주석 제거가 동작한다 (이력 기록이 판정에 섞이지 않는다)", () => {
    const body = code();
    // 파일에는 `section: "intro"` 가 **주석으로만** 남아 있다(종전 동작 기록).
    expect(fs.readFileSync(EDITOR, "utf8")).toContain('`section: "intro"`');
    expect(body).not.toContain('section: "intro"');
  });

  it("🔴 A·B 업로드가 **누른 그룹의 섹션**을 쓴다 (기본값 강제 회귀 차단)", () => {
    const body = code();
    // 그룹 버튼이 자기 섹션을 기억시킨다
    expect(body).toContain("pendingSection.current = section");
    // 파일 선택 후 그 값을 그대로 넘긴다
    expect(body).toContain("uploadFiles(files, pendingSection.current)");
    // 리터럴 섹션을 넘기는 형태가 없어야 한다
    expect(body).not.toMatch(/uploadFiles\(\s*files\s*,\s*"/);
  });

  it("🔴 C 잔여가 0 이면 추가 버튼을 감춘다", () => {
    const body = code();
    expect(body).toContain("const left = remainingSlots(items, section)");
    expect(body).toMatch(/\{left > 0 \? \(/);
    // 상수 조건으로 바꿔치기하는 형태 차단
    expect(body).not.toMatch(/\{true \? \(/);
  });

  it("🔴 D 이동은 순수 함수에만 맡긴다 (컴포넌트 안에서 배열을 직접 스왑하지 않는다)", () => {
    const body = code();
    expect(body).toContain("moveWithinSection(items, index, dir)");
    // 구조분해 스왑(`[a[i], a[j]] = [a[j], a[i]]`)이 다시 들어오면 실패
    expect(body).not.toMatch(/\[\s*\w+\[[^\]]+\]\s*,\s*\w+\[[^\]]+\]\s*\]\s*=/);
  });

  it("🔴 드롭다운·기본값 경로가 되살아나지 않는다", () => {
    const body = code();
    expect(body).not.toContain("<select");
    expect(body).not.toContain("setSection");
    // 총합만 보고 업로드 슬롯을 계산하는 옛 형태
    expect(body).not.toMatch(/DETAIL_IMAGE_MAX\s*-\s*items\.length/);
  });

  it("이동 결과가 null 이면 dirty 를 켜지 않는다 (무의미한 dirty 차단)", () => {
    const body = code();
    // `if (!next) return;` 이 setDirty 앞에 있어야 한다.
    const idx = body.indexOf("moveWithinSection(items, index, dir)");
    const after = body.slice(idx, idx + 400);
    expect(after).toMatch(/if \(!next\) return;/);
    expect(after.indexOf("if (!next) return;")).toBeLessThan(after.indexOf("setDirty(true)"));
  });
});

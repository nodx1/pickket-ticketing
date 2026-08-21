import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseUserRole } from "./permissions";

/**
 * 🔴 팀원 로그인 복구 가드 (2026-07-31).
 *
 * ## 배경
 * 팀원이 로그인해도 **자기 자신이 별도 테넌트**가 돼 행사가 안 보였다.
 * 끊긴 곳이 세 군데였고, **하나만 고치면 증상이 그대로**다:
 *   ① 수락이 팀원을 `is_organizer: true` 로 가입시켜 자기 프로필을 만든다
 *   ② 멤버십 등록이 비어 있는 go `accounts` 를 조회해 조용히 반환한다
 *   ③ 세션 역할이 `"owner"` 하드코딩이다
 *
 * ## 왜 소스 검사인가
 * 이 경로는 v2 왕복이 걸려 있어 단위 테스트로 끝까지 못 간다. 실제 동작은
 * **실계정 로그인**으로만 증명된다(그건 별도 E2E). 여기서는 **되돌아가는 것**을 막는다.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("초대 수락 — 팀원을 주최자로 승격시키지 않는다", () => {
  const FILE = "src/app/api/invitations/accept/route.ts";

  it("🔴 v2 가입을 is_organizer:false 로 부른다", () => {
    // true 면 v2 가 팀원에게도 주최자 프로필을 만든다.
    const s = strip(read(FILE));
    expect(s).toContain("is_organizer: false");
    expect(s).not.toContain("is_organizer: true");
  });

  it("🔴 죽은 accounts 테이블을 조회하지 않는다", () => {
    // 컷오버로 0행이 됐고, 그 조회가 멤버십 등록을 통째로 건너뛰게 했다.
    const s = strip(read(FILE));
    expect(s).not.toMatch(/FROM\s+accounts/i);
  });

  it("🔴 소유자 앵커로 초대 행의 account_id 를 넘긴다", () => {
    expect(strip(read(FILE))).toContain("v2_organizer_ref: invitation.account_id");
  });

  it("🔴 v2 서명 시크릿을 리포 계약대로 읽는다 (GO_WEBHOOK_SECRET 우선)", () => {
    // v2 `internal_sync` 는 전 라우트를 GO_WEBHOOK_SECRET 로 검증한다.
    // 종전엔 V2_EVENT_SYNC_SECRET 단독이라 그 값만 없으면 조용히 스킵됐다.
    // 로컬 실호출로 잡았다 — 단위 테스트는 목이라 서명을 검증하지 않는다.
    const s = strip(read(FILE));
    expect(s).toContain("process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET");
  });

  it("🔴 멤버십 등록 실패를 삼키지 않는다 — 응답에 표시한다", () => {
    // 실패하면 로그인해도 행사가 안 보인다. 200 만 주고 끝내면 아무도 모른다.
    const s = strip(read(FILE));
    expect(s).toContain("membershipLinked");
    expect(s).toMatch(/logger\.error\(/);
  });
});

describe("세션 역할 — v2 가 준 값을 쓴다", () => {
  it("🔴 resolve-session 이 role 하드코딩을 쓰지 않는다", () => {
    const s = strip(read("src/lib/auth/resolve-session.ts"));
    expect(s).toContain("remote.organizerRole");
    // `role: "owner"` 리터럴이 폴백 밖에 남아 있으면 안 된다.
    expect(s).not.toMatch(/role:\s*"owner"\s*,/);
  });

  it("로그인 직후 세션에서 역할을 다시 읽는다", () => {
    // 로그인 라우트는 멤버십을 모른다 — 그 응답의 role 을 그대로 믿으면 팀원이
    // `owner` 로 표시돼 화면이 오판한다(members-client 의 isOwner).
    const s = strip(read("src/lib/stores/authStore.ts"));
    const login = /async login\([\s\S]*?\n  \},/.exec(s);
    expect(login, "login 핸들러를 찾지 못했다").not.toBeNull();
    expect(login![0]).toContain("/api/auth/me");
  });
});

describe("parseUserRole — 모르는 값은 통과시키지 않는다", () => {
  it("알려진 역할은 그대로", () => {
    expect(parseUserRole("owner")).toBe("owner");
    expect(parseUserRole("organizer")).toBe("organizer");
    expect(parseUserRole("staff")).toBe("staff");
  });

  it("🔴 모르는 값은 null — 조용히 권한을 주지 않는다", () => {
    // v2 에 새 팀 역할이 생겼을 때 여기로 흘러든다.
    expect(parseUserRole("manager")).toBeNull();
    expect(parseUserRole("superuser")).toBeNull();
    expect(parseUserRole("")).toBeNull();
  });

  it("프로토타입 속성을 역할로 착각하지 않는다", () => {
    expect(parseUserRole("toString")).toBeNull();
    expect(parseUserRole("constructor")).toBeNull();
  });
});

describe("초대권 쓰기 — 역할 게이트", () => {
  const BASE = "src/app/api/events/[eventId]/invitations";

  it("🔴 대량 발권이 역할을 검사한다", () => {
    // 최대 규모의 되돌릴 수 없는 쓰기인데 무검사였다(읽기는 organizer 요구).
    expect(strip(read(`${BASE}/bulk/route.ts`))).toMatch(
      /export const POST = withRole<[^>]*>\("organizer"/,
    );
  });

  it("🔴 회수·재발송이 역할을 검사한다", () => {
    expect(strip(read(`${BASE}/[invitationId]/route.ts`))).toMatch(
      /export const POST = withRole<[^>]*>\("organizer"/,
    );
  });
});

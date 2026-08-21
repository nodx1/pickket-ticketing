import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { isSpectatorVisible } from "@/lib/live/summary";

/**
 * 🔴 리허설 확인 경로의 경계 (2026-08-07)
 *
 * 8/6~8/19 의 `is_rehearsal: true` 는 **다른 대회의 실제 스코어**다. 관중이 우리 대회로
 * 읽으면 엉뚱한 홀로 이동한다.
 *
 * ```
 * ✅ 경로 분리     /api/events/[eventId]/live/summary   (주최자 세션 + 소유 확인)
 * ❌ 쿼리 플래그   ?rehearsal=1 · 헤더 · 바디
 *    🔴 클라이언트가 만들 수 있는 스위치는 스위치가 아니라 **구멍**이다
 * ```
 *
 * ⚠️ 라우트 핸들러는 세션·DB·v2 클라이언트가 딸려 와 단위 테스트로 실행하기 어렵다.
 *    그래서 **관계**를 본다 — "문자열이 있다" 가 아니라 *어느 파일이 무엇을 부르고,
 *    어느 파일이 무엇을 안 부르는가*. 구멍은 그 관계가 깨지는 자리에 생긴다.
 */

const PUBLIC_ROUTE = "../../app/api/public/live/summary/route.ts";
const OWNER_ROUTE = "../../app/api/events/[eventId]/live/summary/route.ts";

async function source(rel: string): Promise<string> {
  const raw = await readFile(new URL(rel, import.meta.url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

describe("🔴 공개 라우트 — 리허설 우회가 없다", () => {
  it("🔴 쿼리·헤더·바디 어디로도 리허설을 켤 수 없다", async () => {
    const s = await source(PUBLIC_ROUTE);
    expect(s).not.toMatch(/rehearsal/i);
  });

  it("🔴 읽는 쿼리 인자는 ticket 하나뿐이다", async () => {
    const s = await source(PUBLIC_ROUTE);
    const params = [...s.matchAll(/searchParams\.get\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(params).toEqual(["ticket"]);
  });

  it("공개 라우트는 주최자 권한 HOF 를 쓰지 않는다 (관중 경로다)", async () => {
    expect(await source(PUBLIC_ROUTE)).not.toMatch(/withRole|withAuth/);
  });
});

describe("🔴 인증 라우트 — 경로 자체가 권한이다", () => {
  it("🔴 주최자 권한 HOF 로 감싼다", async () => {
    expect(await source(OWNER_ROUTE)).toMatch(/withRole<Params>\(\s*["']organizer["']/);
  });

  it("🔴 eventId 소유를 확인한다 — 남의 행사면 데이터를 안 준다", async () => {
    const s = await source(OWNER_ROUTE);
    expect(s).toMatch(/resolveOwnedV2EventId\(\s*eventId\s*,\s*session\.accountId\s*\)/);
    // 소유 확인 결과가 실제로 분기에 쓰여야 한다 — 부르기만 하고 버리면 가드가 아니다
    expect(s).toMatch(/if\s*\(!owned\)/);
  });

  it("🔴 리허설을 걸러내지 않는다 — 이 경로의 존재 이유다", async () => {
    const s = await source(OWNER_ROUTE);
    expect(s).not.toMatch(/isSpectatorVisible/);
  });

  it("🔴 여기서도 쿼리로 무언가를 켜지 않는다", async () => {
    expect(await source(OWNER_ROUTE)).not.toMatch(/searchParams\.get/);
  });

  it("공개 요약과 **같은 빌더**를 쓴다 (응답 모양이 갈리면 안 된다)", async () => {
    const owner = await source(OWNER_ROUTE);
    const pub = await source(PUBLIC_ROUTE);
    for (const s of [owner, pub]) {
      expect(s).toMatch(/buildSummary\(snap\)/);
      expect(s).toMatch(/emptySummary\(\)/);
    }
  });

  it("v2 장애를 403/404 로 강등하지 않는다 (정상 주최자가 영구 차단된다)", async () => {
    expect(await source(OWNER_ROUTE)).toMatch(/EventAccessError[\s\S]{0,200}503/);
  });
});

describe("관중 노출 판정은 여전히 fail-closed", () => {
  it("🔴 리허설·모름은 관중에게 안 보인다", () => {
    expect(isSpectatorVisible({ is_rehearsal: true })).toBe(false);
    expect(isSpectatorVisible({})).toBe(false);
    expect(isSpectatorVisible({ is_rehearsal: false })).toBe(true);
  });
});

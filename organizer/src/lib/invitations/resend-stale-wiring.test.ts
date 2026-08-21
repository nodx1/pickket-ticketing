import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * 🔴 배선 — 정책이 옳아도 값이 안 오면 소용없다 (2026-08-12).
 *
 * 오늘 등급 설명에서 겪은 그것과 같은 자리다: 화면·정책만 테스트하면
 * v2→API→화면 고리가 끊겨도 전부 초록이다.
 */
async function src(rel: string): Promise<string> {
  const raw = await readFile(new URL(rel, import.meta.url), "utf8");
  return raw.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
}

describe("🔴 dispatch_stale 이 v2 에서 화면까지 온다", () => {
  it("🔴 API 가 v2 값을 그대로 실어 보낸다 — 우리가 만들어내지 않는다", async () => {
    const s = await src("../../app/api/events/[eventId]/invitations/route.ts");
    expect(s, "배선이 끊기면 화면은 영원히 정상으로 보인다").toMatch(
      /dispatchStale:\s*i\.dispatch_stale/,
    );
    // 🔴 기본값으로 접지 마라 — 모름이 false 가 되면 신호가 조용히 사라진다.
    expect(s).not.toMatch(/dispatchStale:\s*i\.dispatch_stale\s*(\?\?|\|\|)/);
  });

  it("🔴 화면이 그 값으로 경고를 띄운다", async () => {
    const s = await src(
      "../../app/(dashboard)/events/[eventId]/invitations/_components/invitation-status-cell.tsx",
    );
    expect(s).toMatch(/row\.dispatchStale === true/);
    expect(s).toMatch(/재발송 필요/);
  });

  it("v2 클라이언트 타입이 그 필드를 안다", async () => {
    const s = await src("../v2/commerce-client.ts");
    expect(s).toMatch(/dispatch_stale\?:\s*boolean/);
  });
});

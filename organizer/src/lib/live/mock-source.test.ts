import { afterEach, describe, expect, it } from "vitest";

import { mockLiveSource } from "@/lib/live/source";

/**
 * 🔴 목 데이터의 「관중 가시」 모드 (2026-08-07)
 *
 * 종전엔 `is_rehearsal: true` 가 하드코딩돼 목 모드로는 라이브 화면을 **아무도 못 봤다**.
 * 화면을 확인하려면 매번 이 파일을 고쳐야 했다.
 *
 * ⚠️ 기본값은 **true** 다 — env 를 안 주면 리허설이고 관중에게 안 보인다(fail-closed).
 */
const KEEP = process.env.LIVE_MOCK_REHEARSAL;
const PHASE = process.env.LIVE_MOCK_PHASE;

afterEach(() => {
  if (KEEP === undefined) delete process.env.LIVE_MOCK_REHEARSAL;
  else process.env.LIVE_MOCK_REHEARSAL = KEEP;
  if (PHASE === undefined) delete process.env.LIVE_MOCK_PHASE;
  else process.env.LIVE_MOCK_PHASE = PHASE;
});

describe("목 원천 — 리허설 토글", () => {
  it("🔴 env 를 안 주면 리허설이다 (fail-closed 기본값)", async () => {
    delete process.env.LIVE_MOCK_REHEARSAL;
    expect((await mockLiveSource.fetchBody()).tournament.is_rehearsal).toBe(true);
  });

  it('LIVE_MOCK_REHEARSAL="false" 면 관중 가시 모드가 된다', async () => {
    process.env.LIVE_MOCK_REHEARSAL = "false";
    expect((await mockLiveSource.fetchBody()).tournament.is_rehearsal).toBe(false);
  });

  it("🔴 아무 값이나 준다고 켜지지 않는다 — 정확히 'false' 만", async () => {
    for (const v of ["0", "no", "true", "FALSE", ""]) {
      process.env.LIVE_MOCK_REHEARSAL = v;
      expect((await mockLiveSource.fetchBody()).tournament.is_rehearsal, v).toBe(true);
    }
  });

  it("진행 중 목도 같은 토글을 따른다", async () => {
    process.env.LIVE_MOCK_PHASE = "play";
    delete process.env.LIVE_MOCK_REHEARSAL;
    expect((await mockLiveSource.fetchBody()).tournament.is_rehearsal).toBe(true);
    process.env.LIVE_MOCK_REHEARSAL = "false";
    expect((await mockLiveSource.fetchBody()).tournament.is_rehearsal).toBe(false);
  });

  it("🔴 목 groups 도 실응답 모양이다 — player_codes 만 준다", async () => {
    process.env.LIVE_MOCK_PHASE = "play";
    const b = await mockLiveSource.fetchBody();
    expect(b.groups[0]).toHaveProperty("player_codes");
    expect(b.groups[0]).not.toHaveProperty("players");
    expect(b.leaderboard.every((r) => r.player_code !== null)).toBe(true);
  });
});

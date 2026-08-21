import { describe, expect, it } from "vitest";

import { STALE_AGE_SEC, buildSummary, emptySummary, isSpectatorVisible } from "@/lib/live/summary";
import { normalizeStatus, normalizeTournament } from "@/lib/live/source";
import type { LiveSnapshot } from "@/lib/live/cache";
import type { LiveBody } from "@/lib/live/source";

/**
 * 요약 계약.
 *
 * 🔴 여기서 지키는 것 넷:
 *   ① `status` 는 **원천 값 그대로** — 우리가 어휘를 만들지 않는다
 *   ② 정지 판정은 **content_age_sec**(원천 본문 수신 시각)로 한다.
 *      `updated_at`(우리 폴링 시각)으로 재면 **영원히 정지를 못 잡는다**
 *   ③ `ranked:false`(실격·기권)는 **한 곳에서** 걸러진다
 *   ④ `is_rehearsal` 게이트는 **fail-closed** — undefined 도 막힌다
 */

const NOW = 1_700_000_000_000;

function body(over: Partial<LiveBody> = {}): LiveBody {
  return {
    tournament: { name: "테스트 대회", round: 2, status: "live", is_rehearsal: false },
    leaderboard: [
      { rank: 1, tied: false, name: "선수 A", player_code: "선수 A", total: -8, current_hole: 15, holes_done: 14, ranked: true },
      { rank: null, tied: false, name: "실격 선수", player_code: "실격 선수", total: null, current_hole: null, holes_done: 0, ranked: false },
    ],
    groups: [
      {
        group_no: 1, tee_time: "06:50", start_hole: 1, current_hole: 15,
        finished: false, player_codes: ["선수 A"],
      },
    ],
    ...over,
  };
}

function snap(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return { body: body(), dataAt: "A", contentAt: NOW, stale: false, checkedAt: NOW, ...over };
}

describe("🔴 status 는 원천 값 그대로 전달된다", () => {
  it("네 값이 그대로 실린다", () => {
    for (const st of ["not_started", "live", "ended", "no_data"] as const) {
      const s = buildSummary(
        snap({ body: body({ tournament: { name: "대회", round: 1, status: st, is_rehearsal: false } }) }),
        NOW,
      );
      expect(s.status).toBe(st);
    }
  });

  it("🔴 우리가 상태를 지어내지 않는다 — before/after 같은 값이 없다", () => {
    const s = buildSummary(snap(), NOW);
    expect(["not_started", "live", "ended", "no_data"]).toContain(s.status);
    expect(s).not.toHaveProperty("state");
  });

  it("모르는 원천 값은 no_data 다 (진행 중이라고 단정하지 않는다)", () => {
    expect(normalizeStatus("weird")).toBe("no_data");
    expect(normalizeStatus(null)).toBe("no_data");
    expect(normalizeStatus("NOT-STARTED")).toBe("not_started");
  });

  it("🔴 stale 은 status 와 **별개 필드**다", () => {
    const s = buildSummary(snap({ stale: true }), NOW);
    expect(s.status).toBe("live"); // 원천은 여전히 live 라고 말한다
    expect(s.stale).toBe(true); // 그런데 우리 파이프가 멈췄다
  });
});

describe("🔴 정지 판정 — content_age_sec 로 잰다", () => {
  it("🔴 라운드 시작 직후 — 아무도 홀을 안 끝냈으면 오래돼도 stale 이 **아니다**", () => {
    // 2026-08-07 06:52 실측(제주삼다수 2R 시작 직후):
    //   status=live · stale=false · content_age_sec=35,477(9.9시간) · 전원 holes_done=0
    // 어제 라운드가 끝난 뒤로 안 바뀐 것이 정상이다. 이걸 「지연」으로 읽으면
    // 🔴 매일 아침 첫 홀이 끝날 때까지 화면이 항상 「갱신 지연」으로 뜬다.
    const morning = snap({
      contentAt: NOW - 10 * 3600 * 1000, // 9.9시간 전 = 어제 라운드 종료
      body: body({
        leaderboard: [
          { rank: 1, tied: true, name: "박예지", player_code: "박예지", total: -6, current_hole: 10, holes_done: 0, ranked: true },
          { rank: 1, tied: true, name: "서어진", player_code: "서어진", total: -6, current_hole: 1, holes_done: 0, ranked: true },
        ],
      }),
    });
    expect(morning.body.leaderboard.every((r) => r.holes_done === 0)).toBe(true);
    expect(buildSummary(morning, NOW).stale, "아침에 거짓 지연이 뜨면 안 된다").toBe(false);
  });

  it("🔴 원천이 stale 이라고 하면 홀 진행과 무관하게 stale 이다", () => {
    const morning = snap({
      stale: true,
      body: body({
        leaderboard: [{ rank: 1, tied: false, name: "박예지", player_code: "박예지", total: -6, current_hole: 1, holes_done: 0, ranked: true }],
      }),
    });
    expect(buildSummary(morning, NOW).stale).toBe(true);
  });

  it("본문이 5분 넘게 안 왔으면 stale (경기가 이미 진행된 뒤)", () => {
    const s = buildSummary(snap({ contentAt: NOW - STALE_AGE_SEC * 1000 }), NOW);
    expect(s.stale).toBe(true);
    expect(s.content_age_sec).toBeGreaterThanOrEqual(STALE_AGE_SEC);
  });

  it("5분 직전이면 아직 stale 이 아니다 (경계 반대쪽)", () => {
    expect(buildSummary(snap({ contentAt: NOW - (STALE_AGE_SEC * 1000 - 1000) }), NOW).stale).toBe(false);
  });

  it("🔴 우리가 계속 폴링해도(checkedAt 최신) 본문이 멈췄으면 stale 이다", () => {
    // 이게 핵심이다. updated_at 으로 재면 이 케이스에서 영원히 정상으로 보인다.
    const s = buildSummary(snap({ contentAt: NOW - 10 * 60 * 1000, checkedAt: NOW, stale: false }), NOW);
    expect(s.stale).toBe(true);
    expect(new Date(s.updated_at).getTime()).toBe(NOW); // updated_at 은 방금이다
    expect(s.content_age_sec).toBeCloseTo(600, 0);
  });
});

describe("🔴 is_rehearsal — 관중 노출 게이트는 fail-closed", () => {
  it("리허설이면 관중에게 안 보인다", () => {
    expect(isSpectatorVisible({ is_rehearsal: true })).toBe(false);
  });

  it("🔴 필드가 없으면(undefined) **막힌다** — falsy 검사면 여기서 샌다", () => {
    expect(isSpectatorVisible({})).toBe(false);
    expect(isSpectatorVisible({ is_rehearsal: undefined })).toBe(false);
  });

  it("명시적으로 false 일 때만 보인다", () => {
    expect(isSpectatorVisible({ is_rehearsal: false })).toBe(true);
  });

  it("응답에는 값이 **그대로** 실린다 (게이트와 별개로 전달한다)", () => {
    const s = buildSummary(
      snap({ body: body({ tournament: { name: "대회", round: 1, status: "live", is_rehearsal: true } }) }),
      NOW,
    );
    expect(s.is_rehearsal).toBe(true);
  });

  it("🔴 원천이 필드를 안 주면 리허설로 본다 (정규화도 fail-closed)", () => {
    expect(normalizeTournament({ name: "대회" }).is_rehearsal).toBe(true);
    expect(normalizeTournament({ name: "대회", is_rehearsal: false }).is_rehearsal).toBe(false);
  });
});

describe("🔴 ranked:false 는 요약에서 걸러진다", () => {
  it("실격 선수가 leaders 에 없다", () => {
    const s = buildSummary(snap(), NOW);
    expect(s.leaders).toHaveLength(1);
    expect(s.leaders.map((l) => l.name)).not.toContain("실격 선수");
  });

  it("ranked 필드 자체를 화면에 흘리지 않는다 (거르는 책임이 여기 있다)", () => {
    expect(buildSummary(snap(), NOW).leaders[0]).not.toHaveProperty("ranked");
  });
});

describe("캐시가 없을 때", () => {
  it("🔴 no_data 다 — 「대회 전」이라고 단정하지 않는다", () => {
    const s = emptySummary(NOW);
    expect(s.status).toBe("no_data");
    expect(s.stale).toBe(true);
    expect(s.is_rehearsal).toBe(true); // fail-closed
    expect(isSpectatorVisible(s)).toBe(false);
  });
});

/**
 * 🔴 조편성 이름 잇기 (2026-08-07 실응답)
 *
 * 원천 `/groups` 는 `player_codes` 만 준다 — 이름이 없다. 그대로 내리면 조편성 화면의
 * 선수 이름이 빈 채로 뜬다. 조편성은 이번 대회의 **핵심 화면**이다.
 */
describe("🔴 조편성 — player_codes 에 이름을 이어 붙인다", () => {
  function withGroups(): LiveSnapshot {
    return snap({
      body: body({
        leaderboard: [
          { rank: 1, tied: false, name: "박예지", player_code: "A1", total: -6, current_hole: 15, holes_done: 14, ranked: true },
          { rank: 2, tied: false, name: "서어진", player_code: "A2", total: -4, current_hole: 15, holes_done: 14, ranked: true },
          // 🔴 실격 — 리더보드에서는 빠지지만 조에는 남아야 한다
          { rank: null, tied: false, name: "기권선수", player_code: "A3", total: null, current_hole: null, holes_done: 0, ranked: false },
        ],
        groups: [
          {
            group_no: 1, tee_time: "06:50", start_hole: 1, current_hole: 15,
            finished: false, player_codes: ["A1", "A2", "A3"],
          },
          {
            group_no: 2, tee_time: "06:50", start_hole: 10, current_hole: 6,
            finished: false, player_codes: ["ZZ"], // 리더보드에 없는 코드
          },
        ],
      }),
    });
  }

  it("🔴 조원 이름이 채워진다 (화면이 잇게 두지 않는다)", () => {
    const g = buildSummary(withGroups(), NOW).groups[0]!;
    expect(g.players.map((p) => p.name)).toEqual(["박예지", "서어진", "기권선수"]);
    expect(g.players[0]!.total).toBe(-6);
  });

  it("🔴 ranked:false 도 **조에는 남는다** — 조원 3명이 3명이다", () => {
    // 실격 선수도 같은 조로 나가 있고, 갤러리는 그 조를 따라간다.
    const s = buildSummary(withGroups(), NOW);
    expect(s.groups[0]!.players).toHaveLength(3);
    expect(s.groups[0]!.players.map((p) => p.name)).toContain("기권선수");
    // 리더보드에서는 빠져 있다
    expect(s.leaders.map((l) => l.name)).not.toContain("기권선수");
  });

  it("🔴 코드가 리더보드에 없으면 **이름만 비고 조는 남는다**", () => {
    const s = buildSummary(withGroups(), NOW);
    const g2 = s.groups.find((g) => g.group_no === 2);
    expect(g2, "🔴 조가 통째로 사라졌다 — 조 번호·티오프·출발 홀은 그 자체로 유효하다").toBeDefined();
    expect(g2!.players).toHaveLength(1);
    expect(g2!.players[0]!.name).toBeNull();
    expect(g2!.players[0]!.player_code).toBe("ZZ");
    // 출발 홀은 살아 있어야 한다 — 현장에서 조를 찾는 데 이름보다 중요할 때가 있다
    expect(g2!.start_hole).toBe(10);
  });

  it("응답에 원시 player_codes 를 그대로 흘리지 않는다 (잇는 책임이 여기 있다)", () => {
    expect(buildSummary(withGroups(), NOW).groups[0]!).not.toHaveProperty("player_codes");
  });

  it("2티 출발이 보존된다 — 같은 시각에 1번홀·10번홀", () => {
    const s = buildSummary(withGroups(), NOW);
    expect(s.groups.map((g) => [g.tee_time, g.start_hole])).toEqual([
      ["06:50", 1],
      ["06:50", 10],
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { normalizeGroups, normalizeLeaderboard } from "@/lib/live/source";

/**
 * 🔴 실응답 봉투 — 2026-08-07 실키 첫 연결에서 잡힌 결함.
 *
 * 대회명은 오는데 **리더보드·조편성이 통째로 빈 배열**로 내려갔다.
 * `rows()` 가 `result`·`data`·`list`·`items` 만 보고 있었고, 실응답은
 * `{ entries: [...] }` · `{ groups: [...] }` 였다.
 *
 * ⚠️ 목 데이터는 우리가 만든 모양이라 통과했다 — **실응답에만 있는 결함**이다.
 *    실키로 붙어보지 않았으면 대회 당일에 알았다.
 */
describe("🔴 실응답 봉투 — entries · groups", () => {
  it("리더보드가 { entries: [...] } 로 와도 읽는다", () => {
    const rows = normalizeLeaderboard({
      entries: [
        { rank: 1, tied: true, ranked: true, player_code: "9138", name: "강수은", total: -2, holes_done: 3, current_hole: 4 },
      ],
    });
    expect(rows, "entries 를 못 읽으면 리더보드가 통째로 빈다").toHaveLength(1);
    expect(rows[0].name).toBe("강수은");
    expect(rows[0].player_code).toBe("9138");
    expect(rows[0].holes_done).toBe(3);
  });

  it("조편성이 { groups: [...] } 로 와도 읽는다", () => {
    const rows = normalizeGroups({
      groups: [
        { group_no: 1, tee_time: "06:50", start_hole: 1, current_hole: 4, finished: false, player_codes: ["9436", "9277"] },
      ],
    });
    expect(rows, "groups 를 못 읽으면 조편성이 통째로 빈다").toHaveLength(1);
    expect(rows[0].start_hole, "출발 홀은 현장에서 조를 찾는 유일한 단서다").toBe(1);
    expect(rows[0].player_codes).toEqual(["9436", "9277"]);
  });

  it("종전 봉투(result·data)도 계속 읽는다 — 가산적 변경이었다", () => {
    expect(normalizeLeaderboard({ result: [{ rank: 1, name: "A", total: 0 }] })).toHaveLength(1);
    expect(normalizeLeaderboard([{ rank: 1, name: "A", total: 0 }])).toHaveLength(1);
  });
});

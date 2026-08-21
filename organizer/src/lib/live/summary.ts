/**
 * 라이브 요약 — 화면 하나를 채우는 **한 번의 응답**.
 *
 * 브라우저가 리더보드·조편성·대회정보를 각각 부르면 갤러리 수만큼 곱해진다.
 * 그래서 한 라우트가 전부 담아 내린다.
 *
 * ## 🔴 상태 어휘를 우리가 만들지 않는다 (2026-08-06 정정)
 *
 * 처음엔 `before | live | stale | after` 를 우리가 지어냈다. **버렸다.**
 * 두 벌을 유지하면 언젠가 갈리고, 그때 갈린 쪽이 화면이다.
 *
 * ```
 * status           원천 값 그대로 (not_started | live | ended | no_data)
 * stale            🔴 **별도** boolean — 우리 갱신이 멈췄는가
 * is_rehearsal     원천 값 그대로 — 8/6~8/19 는 **다른 대회의 실제 스코어**다
 * content_age_sec  원천 본문을 마지막으로 받은 뒤 흐른 초
 * game_code        어느 대회의 값인가
 * ```
 *
 * ⚠️ 날짜 하드코딩·대회명 문자열 비교로 상태를 추론하지 않는다. 원천이 한 번만 바뀌어도
 *    조용히 틀리고, 아무도 못 알아챈다.
 */
import type { LiveSnapshot } from "@/lib/live/cache";
import type { LiveGroup, LiveLeaderRow, LiveStatus } from "@/lib/live/source";
import { liveGameCode } from "@/lib/live/source";

/** 이보다 오래된 내용이면 「실시간」이라고 부르지 않는다. */
export const STALE_AGE_SEC = 300;

/** 화면이 그리는 리더 한 줄. `ranked` 는 요약 단계에서 이미 걸러졌다. */
export type LiveSummaryLeader = Omit<LiveLeaderRow, "ranked">;

export interface LiveSummary {
  /** 🔴 원천 값 그대로. */
  status: LiveStatus;
  /** 🔴 status 와 **별개**다. 원천이 live 여도 우리 파이프가 멈추면 true. */
  stale: boolean;
  /** 🔴 다른 대회의 실제 스코어인가. 관중 노출 판정의 근거. */
  is_rehearsal: boolean;
  game_code: string;
  tournament: { name: string | null; round: number | null };
  leaders: LiveSummaryLeader[];
  groups: LiveSummaryGroup[];
  /** 🔴 **원천 본문**을 마지막으로 받은 뒤 흐른 초. 정지 판정의 유일한 근거다. */
  content_age_sec: number;
  /** 표시용 기준 시각(우리가 마지막으로 확인한 시각). 판정에 쓰지 않는다. */
  updated_at: string;
}

/**
 * 🔴 **관중에게 보여도 되는가** — 판정은 여기 하나다.
 *
 * 8/6~8/19 의 `is_rehearsal: true` 는 **다른 대회의 실제 스코어**다. 그걸 우리 대회로
 * 읽으면 관중이 엉뚱한 홀로 이동한다.
 *
 * ## ⚠️ falsy 검사를 쓰면 안 되는 이유
 *
 * ```
 * if (!s.is_rehearsal) show()      🔴 undefined(구버전 응답)에서 **샌다**
 * s.is_rehearsal === false         ✅ true 도 undefined 도 막힌다
 * ```
 *
 * 🔴 **모르면 막는다(fail-closed).** 지시서는 "`=== true` 로 막으라"고 했지만, 그 형태만
 *    쓰면 `undefined` 가 통과한다 — 같은 지시서가 *"필드 없는 응답(undefined)도 막혀야
 *    한다"* 고 못박았고 뮤테이션 V7 도 그 자리를 겨눈다. 두 요구를 동시에 만족하는 형태는
 *    **`=== false` 일 때만 노출**이다.
 */
export function isSpectatorVisible(
  summary: Pick<Partial<LiveSummary>, "is_rehearsal">,
): boolean {
  return summary.is_rehearsal === false;
}

/** 조원 한 명 — 코드에 이름·타수를 이어 붙인 결과. */
export interface LiveSummaryPlayer {
  player_code: string;
  /** 🔴 리더보드에 그 코드가 없으면 `null`. **자리는 남긴다.** */
  name: string | null;
  total: number | null;
  current_hole: number | null;
}

export type LiveSummaryGroup = Omit<LiveGroup, "player_codes"> & {
  players: LiveSummaryPlayer[];
};

/**
 * 🔴 **조편성에 선수 이름을 이어 붙인다** (2026-08-07).
 *
 * 원천 `/groups` 는 **`player_codes` 만** 준다 — 이름이 없다. 그대로 내려보내면
 * 조편성 화면의 선수 이름이 빈 채로 뜬다. 조편성은 이번 대회의 **핵심 화면**이라
 * (「내 선수」를 빼고 조 단위만 하기로 확정) 이름이 없으면 그 화면이 쓸모없어진다.
 *
 * 이름·타수는 `/leaderboard` 에 `player_code` 와 함께 온다 ⟹ **여기서** 잇는다.
 * 화면이 하게 두면 리더보드와 조편성이 서로 다른 명단을 보여준다.
 *
 * ## 🔴 경계 둘
 *
 * ```
 * ① 코드가 리더보드에 없으면  이름만 null 로 두고 **자리는 남긴다**
 *    조를 통째로 버리지 않는다 — 조 번호·티오프·출발 홀은 그 자체로 유효한 정보다
 *    (현장에서 조를 찾는 데 이름보다 출발 홀이 더 중요할 때가 있다)
 *
 * ② ranked:false(실격·기권)도 **조에는 남는다**
 *    리더보드에서만 빠진다. 실격 선수도 같은 조로 나가 있고 갤러리는 그 조를 따라간다
 *    ⟹ 여기서는 **거르지 않은** 리더보드 전체로 맵을 만든다
 * ```
 */
function joinGroupNames(
  groups: LiveGroup[],
  leaderboard: LiveLeaderRow[],
): LiveSummaryGroup[] {
  // 🔴 rankedOnly 를 통과하기 **전** 명단으로 만든다(경계 ②).
  const byCode = new Map<string, LiveLeaderRow>();
  for (const r of leaderboard) {
    if (r.player_code) byCode.set(r.player_code, r);
  }
  return groups.map(({ player_codes, ...rest }) => ({
    ...rest,
    players: player_codes.map((code) => {
      const row = byCode.get(code);
      return {
        player_code: code,
        name: row?.name ?? null,
        total: row?.total ?? null,
        current_hole: row?.current_hole ?? null,
      };
    }),
  }));
}

/**
 * 🔴 `ranked:false`(실격·기권)는 **여기서** 뺀다.
 *
 * 화면이 거르게 두면 리더보드와 조편성이 서로 다른 명단을 보여준다 — 같은 선수가
 * 한쪽엔 있고 한쪽엔 없다. 한 곳에서 걸러야 갈리지 않는다.
 */
function rankedOnly(rows: LiveLeaderRow[]): Array<Omit<LiveLeaderRow, "ranked">> {
  return rows
    .filter((r) => r.ranked)
    .map(({ ranked: _ranked, ...rest }) => rest);
}

export function buildSummary(snap: LiveSnapshot, now: number = Date.now()): LiveSummary {
  // 🔴 **`contentAt` 으로 잰다.** `checkedAt`(= 우리가 폴링한 시각)으로 재면
  //    우리가 부를 때마다 갱신되므로 **영원히 정지를 못 잡는다**(스펙 §6-2 가 명시).
  const contentAgeSec = Math.max(0, (now - snap.contentAt) / 1000);

  // 🔴 **오늘 스코어가 한 번이라도 움직였는가.**
  //
  //    2026-08-07 06:52 실측(제주삼다수 2R 시작 직후):
  //      status=live · stale=false · content_age_sec=35,477(9.9시간) · 전원 holes_done=0
  //    어제 1R 이 끝난 뒤로 스코어가 안 바뀐 것이 **정상**이다. 오늘 첫 홀이 끝나야 바뀐다.
  //
  //    ⚠️ 종전 규칙(`contentAgeSec >= 300`)은 이 상태를 「지연」으로 읽었다.
  //       ⟹ **매일 아침 첫 홀이 끝날 때까지 화면이 항상 「갱신 지연」으로 뜬다.**
  //       8/20 아침이 정확히 그 시간이다 — 게이트로 들어온 갤러리가 처음 여는 순간이다.
  //
  //    스펙 §6-2 의 "5분 넘으면 이상 신호" 는 **경기가 실제로 진행 중일 때** 이야기다.
  //    그래서 상대가 준 `stale` 을 정본으로 쓰고, 나이는 **오늘 진행이 시작된 뒤에만** 본다.
  const anyHoleDone = snap.body.leaderboard.some((r) => (r.holes_done ?? 0) > 0);

  return {
    status: snap.body.tournament.status,
    // 🔴 상대의 `stale` 이 정본이다(hold_reason 까지 준다). 나이는 보조 신호로만 쓴다.
    stale: snap.stale || (anyHoleDone && contentAgeSec >= STALE_AGE_SEC),
    is_rehearsal: snap.body.tournament.is_rehearsal,
    game_code: liveGameCode(),
    tournament: { name: snap.body.tournament.name, round: snap.body.tournament.round },
    leaders: rankedOnly(snap.body.leaderboard),
    groups: joinGroupNames(snap.body.groups, snap.body.leaderboard),
    content_age_sec: Math.round(contentAgeSec * 10) / 10,
    updated_at: new Date(snap.checkedAt).toISOString(),
  };
}

/**
 * 캐시가 아예 없을 때(첫 요청·원천 미기동).
 *
 * 🔴 `status="no_data"` 다 — 「대회 전」이라고 **단정하지 않는다**. 모르는 것과 아직
 *    시작 안 한 것은 다르고, 그 둘을 섞으면 원천 장애가 정상 화면으로 위장된다.
 *    `is_rehearsal` 은 fail-closed 로 true.
 */
export function emptySummary(now: number = Date.now()): LiveSummary {
  return {
    status: "no_data",
    stale: true,
    is_rehearsal: true,
    game_code: liveGameCode(),
    tournament: { name: null, round: null },
    leaders: [],
    groups: [],
    content_age_sec: 0,
    updated_at: new Date(now).toISOString(),
  };
}

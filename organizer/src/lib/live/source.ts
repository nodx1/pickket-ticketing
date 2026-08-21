/**
 * AllSet LiveScore 원천 어댑터 — **키가 오면 갈아끼우는 자리는 여기 하나다.**
 *
 * ## 왜 파일을 따로 두는가
 *
 * 지시서 §6: *"키가 없다. 목으로 만들되 **키가 오면 갈아끼울 자리를 하나로 모을 것**"*.
 * 캐시(`cache.ts`)·요약(`summary.ts`)·라우트는 이 모듈의 **정규화된 모양**만 안다.
 * 원천 필드명이 실제와 다르면 고칠 곳은 이 파일의 `normalize*` 뿐이다.
 *
 * ## ⚠️ 지금 상태 (2026-08-06)
 *
 *     키          없다. 상대 스펙 §9-1(재배포 권리 서면)이 블로킹 — 대표 진행 중
 *     서버        `api.livescore.inria.ai/api/v1/rev` 가 **404**(미기동). 배포 세션 실측
 *     ⟹ LIVE_SOURCE_MODE=mock 이 기본이다. 키·URL 이 오면 env 만 바꾼다
 *
 * ## ✅ 2026-08-07 — 실응답을 봤다. 후보를 좁혔다
 *
 * 처음엔 스펙 원문이 없어 snake·camel 을 둘 다 받았다. 실키로 첫 접속한 결과
 * **전부 snake_case** 였다 ⟹ camel 후보를 지웠다. 추측을 영구 계약으로 남기지 않는다.
 *
 * ```
 * /rev          status · is_rehearsal · game_code · data_at · server_time
 * /tournament   + name · round · phase · stale · hold_reason · content_age_sec …
 * /leaderboard  entries[] : rank · tied · ranked · player_code · name · total
 *                           · holes_done · current_hole · group_no · tee_time …
 * /groups       groups[] : group_no · tee_time · start_hole · current_hole
 *                          · finished · 🔴 **player_codes**  ← 이름이 없다
 * ```
 */

/** 정규화된 원천 모양 — 캐시·요약이 아는 유일한 계약. */
/**
 * 🔴 **원천이 주는 값을 그대로 쓴다.** 우리가 상태 어휘를 따로 만들지 않는다.
 *
 * 두 벌을 유지하면 언젠가 갈린다 — 날짜 하드코딩·대회명 문자열 비교로 상태를 추론하는
 * 코드는 원천이 한 번만 바뀌어도 조용히 틀린다.
 */
export type LiveStatus = "not_started" | "live" | "ended" | "no_data";

export interface LiveTournament {
  name: string | null;
  round: number | null;
  /** 원천 상태 그대로. 못 읽으면 `no_data`(모른다 — 진행 중이라고 단정하지 않는다). */
  status: LiveStatus;
  /**
   * 🔴 리허설(다른 대회의 **실제 스코어**)인가. 8/6~8/19 가 그 기간이다.
   *
   * ⚠️ 기본값이 **true** 다 — 원천이 이 필드를 안 주면 **관중에게 안 보인다**.
   *    모를 때 보여주는 쪽이 훨씬 비싸다(다른 대회 스코어를 우리 대회로 읽는다).
   */
  is_rehearsal: boolean;
}

export interface LivePlayer {
  name: string;
  total: number | null;
}

export interface LiveLeaderRow extends LivePlayer {
  rank: number | null;
  tied: boolean;
  current_hole: number | null;
  /**
   * 🔴 **끝낸 홀 수.** 「오늘 경기가 실제로 진행됐는가」를 판정하는 유일한 신호다.
   *
   * 2026-08-07 06:52 실측: 2R 시작 직후 전원 `0` 이고 `content_age_sec` 는 9.9시간이었다.
   * 어제 라운드가 끝난 뒤로 스코어가 안 바뀐 것이 정상이다 — 이걸 「지연」으로 읽으면
   * **매일 아침 첫 홀이 끝날 때까지 화면이 항상 지연으로 뜬다**(summary.ts 참조).
   */
  holes_done?: number | null;
  /** 🔴 조편성의 `player_codes` 를 이름으로 바꾸는 유일한 열쇠. */
  player_code: string | null;
  /** 🔴 false = 실격·기권. **리더보드에서만** 빠진다 — 조에는 남는다. */
  ranked: boolean;
}

export interface LiveGroup {
  group_no: number | null;
  tee_time: string | null;
  /** 🔴 1번홀·10번홀 2티 출발이라 조 번호만으로는 현장에서 못 찾는다. */
  start_hole: number | null;
  current_hole: number | null;
  finished: boolean;
  /**
   * 🔴 **코드만 온다. 이름이 없다** (2026-08-07 실응답 확인).
   *
   * 종전 코드는 `players[] {name, total}` 를 기대했다 — 그런 키는 오지 않는다.
   * ⟹ 조편성 화면의 선수 이름이 **빈 채로** 뜬다. 조편성은 이번 대회의 핵심 화면이다.
   *
   * 이름·타수는 `/leaderboard` 에 `player_code` 와 함께 오므로 **요약 단계에서**
   * 이어 붙인다(`summary.ts`). 화면이 하게 두면 리더보드와 조편성이 갈린다.
   */
  player_codes: string[];
}

export interface LiveBody {
  tournament: LiveTournament;
  leaderboard: LiveLeaderRow[];
  groups: LiveGroup[];
}

/** `/api/v1/rev` — 약 80바이트. 본문을 받을지 결정하는 지문. */
export interface LiveRev {
  data_at: string | null;
}

export class LiveSourceError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "timeout" | "shape",
  ) {
    super(message);
    this.name = "LiveSourceError";
  }
}

// ── 관대한 필드 읽기 ────────────────────────────────────────────────────────

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    // 총타수는 "-8" · "E" · "+3" 로 올 수 있다. E(이븐)는 0 이다.
    const t = v.trim().toUpperCase();
    if (t === "E" || t === "EVEN") return 0;
    const n = Number(t.replace(/^\+/, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "y" || t === "1") return true;
    if (t === "false" || t === "n" || t === "0") return false;
  }
  return fallback;
}

function rows(payload: unknown): Record<string, unknown>[] {
  // 🔴 2026-08-07 실키 첫 연결에서 잡힌 것 — `entries`·`groups` 가 목록에 없었다.
  //    대회명은 오는데 리더보드·조편성이 **빈 배열**로 내려갔다.
  //    목 데이터는 우리가 만든 모양이라 통과했다 — 실응답에만 있는 결함이다.
  //
  //    실측 키:  /leaderboard → { entries: [...] }   /groups → { groups: [...] }
  const c = payload as Record<string, unknown> | unknown[] | null;
  if (Array.isArray(c)) return c as Record<string, unknown>[];
  if (c && typeof c === "object") {
    for (const k of ["entries", "groups", "result", "data", "list", "items"]) {
      const v = (c as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

// ── 정규화 ─────────────────────────────────────────────────────────────────

const STATUS_VALUES: readonly LiveStatus[] = ["not_started", "live", "ended", "no_data"];

/** 원천 상태를 그대로 받는다. 모르는 값은 `no_data` — 우리가 뜻을 지어내지 않는다. */
export function normalizeStatus(v: unknown): LiveStatus {
  const t = str(v)?.toLowerCase().replace(/[\s-]/g, "_");
  return (STATUS_VALUES as readonly string[]).includes(t ?? "")
    ? (t as LiveStatus)
    : "no_data";
}

export function normalizeRev(payload: unknown): LiveRev {
  const o = (payload ?? {}) as Record<string, unknown>;
  const inner = (o.result ?? o.data ?? o) as Record<string, unknown>;
  return { data_at: str(pick(inner, "data_at")) };
}

export function normalizeTournament(payload: unknown): LiveTournament {
  const o = (payload ?? {}) as Record<string, unknown>;
  const t = (o.result ?? o.data ?? o) as Record<string, unknown>;
  return {
    name: str(pick(t, "name")),
    round: num(pick(t, "round")),
    status: normalizeStatus(pick(t, "status")),
    // 🔴 fail-closed. 모르면 리허설로 본다.
    is_rehearsal: bool(pick(t, "is_rehearsal"), true),
  };
}

export function normalizeLeaderboard(payload: unknown): LiveLeaderRow[] {
  return rows(payload).map((r) => ({
    rank: num(pick(r, "rank")),
    // 🔴 공동순위 기본값은 false 다. 모르면 "공동"이라고 부르지 않는다.
    tied: bool(pick(r, "tied"), false),
    name: str(pick(r, "name")) ?? "",
    player_code: str(pick(r, "player_code")),
    total: num(pick(r, "total")),
    current_hole: num(pick(r, "current_hole")),
    holes_done: num(pick(r, "holes_done")),
    // 🔴 기본값 true — 원천이 이 필드를 안 주면 **정상 선수**로 본다.
    //    false 로 기본을 잡으면 필드가 없는 순간 리더보드가 통째로 빈다.
    ranked: bool(pick(r, "ranked"), true),
  }));
}

export function normalizeGroups(payload: unknown): LiveGroup[] {
  return rows(payload).map((g) => ({
    group_no: num(pick(g, "group_no")),
    tee_time: str(pick(g, "tee_time")),
    start_hole: num(pick(g, "start_hole")),
    current_hole: num(pick(g, "current_hole")),
    finished: bool(pick(g, "finished"), false),
    // 🔴 실응답 키는 `player_codes` 뿐이다. `players` 를 찾던 옛 코드는 늘 빈 배열을 얻었다.
    player_codes: (Array.isArray(pick(g, "player_codes")) ? (pick(g, "player_codes") as unknown[]) : [])
      .map((c) => str(c))
      .filter((c): c is string => c !== null),
  }));
}

// ── 원천 호출 ───────────────────────────────────────────────────────────────

const TIMEOUT_MS = 4_000;

function baseUrl(): string {
  return (process.env.LIVE_SOURCE_BASE_URL ?? "https://livescore-api.inria.ai").replace(/\/+$/, "");
}

export function liveGameCode(): string {
  return process.env.LIVE_GAME_CODE ?? "";
}

/** mock = 목 데이터(기본). live = 실제 원천. 키가 오면 env 만 바꾼다. */
export function liveSourceMode(): "mock" | "live" {
  return process.env.LIVE_SOURCE_MODE === "live" ? "live" : "mock";
}

async function getJson(path: string): Promise<unknown> {
  const key = process.env.LIVE_SOURCE_API_KEY ?? "";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: {
        accept: "application/json",
        ...(key ? { "x-api-key": key } : {}),
      },
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new LiveSourceError(`live source ${res.status} on ${path}`, "http");
    }
    return await res.json();
  } catch (err: unknown) {
    if (err instanceof LiveSourceError) throw err;
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new LiveSourceError(
      `live source ${aborted ? "timeout" : "failure"} on ${path}: ` +
        (err instanceof Error ? err.message : "unknown"),
      aborted ? "timeout" : "http",
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface LiveSource {
  fetchRev(): Promise<LiveRev>;
  fetchBody(): Promise<LiveBody>;
}

export const httpLiveSource: LiveSource = {
  async fetchRev() {
    const g = encodeURIComponent(liveGameCode());
    return normalizeRev(await getJson(`/api/v1/rev?game=${g}`));
  },
  async fetchBody() {
    const g = encodeURIComponent(liveGameCode());
    // 🔴 셋을 **동시에** 받는다. 순차로 받으면 세 시점이 섞인 화면이 나온다.
    const [tournament, leaderboard, groups] = await Promise.all([
      getJson(`/api/v1/tournament?game=${g}`),
      getJson(`/api/v1/leaderboard?game=${g}`),
      getJson(`/api/v1/groups?game=${g}`),
    ]);
    return {
      tournament: normalizeTournament(tournament),
      leaderboard: normalizeLeaderboard(leaderboard),
      groups: normalizeGroups(groups),
    };
  },
};

/**
 * 목 원천 — 키가 오기 전까지 화면을 만들 수 있게 한다.
 *
 * ⚠️ 목은 **대회 전(before)** 을 기본으로 준다. 첫날 아침 06:00~07:00 이 갤러리가 가장
 *    많이 열어보는 시각인데 그때 조편성이 아직 없다(스펙 §7). 목이 늘 데이터를 주면
 *    그 화면을 아무도 안 만든다.
 */
/**
 * 🔴 목이 **관중에게 보이는** 모드로 뜰 수 있게 한다 (2026-08-07).
 *
 * 종전엔 `is_rehearsal: true` 가 하드코딩돼 있어 **목 모드로는 라이브 화면을 아무도 못
 * 봤다** — 화면을 확인하려면 매번 이 파일을 고쳐야 했다(배포 세션이 실제로 그랬다).
 *
 * ⚠️ 기본값은 **true** 다. env 를 안 주면 리허설이고, 관중에게 안 보인다.
 *    fail-closed 를 기본으로 유지한다 — 프로덕션 env 에는 넣지 않는다(개발·검증용).
 */
function mockIsRehearsal(): boolean {
  return process.env.LIVE_MOCK_REHEARSAL !== "false";
}

export const mockLiveSource: LiveSource = {
  async fetchRev() {
    return { data_at: process.env.LIVE_MOCK_DATA_AT ?? "2026-08-20T10:42:00+09:00" };
  },
  async fetchBody() {
    if (process.env.LIVE_MOCK_PHASE === "play") {
      return {
        tournament: {
          name: "BC카드·한경 제48회 KLPGA 챔피언십", round: 2,
          status: "live", is_rehearsal: mockIsRehearsal(),
        },
        leaderboard: [
          { rank: 1, tied: false, name: "선수 A", player_code: "P1", total: -8, current_hole: 15, holes_done: 14, ranked: true },
          { rank: 2, tied: true, name: "선수 B", player_code: "P2", total: -6, current_hole: 14, holes_done: 13, ranked: true },
          { rank: 2, tied: true, name: "선수 C", player_code: "P3", total: -6, current_hole: 16, holes_done: 15, ranked: true },
          // 🔴 실격 — 리더보드에서는 빠지지만 **조에는 남아야** 한다
          { rank: null, tied: false, name: "선수 D", player_code: "P4", total: null, current_hole: null, holes_done: 0, ranked: false },
          { rank: 8, tied: false, name: "선수 E", player_code: "P5", total: 1, current_hole: 15, holes_done: 14, ranked: true },
          { rank: 9, tied: false, name: "선수 F", player_code: "P6", total: 2, current_hole: 6, holes_done: 5, ranked: true },
        ],
        // 🔴 실응답과 같은 모양 — 코드만 온다
        groups: [
          {
            group_no: 1, tee_time: "06:50", start_hole: 1, current_hole: 15, finished: false,
            player_codes: ["P1", "P2", "P5"],
          },
          {
            group_no: 2, tee_time: "06:50", start_hole: 10, current_hole: 6, finished: false,
            // P4 = 실격 선수, P9 = 리더보드에 없는 코드(이름만 비고 자리는 남는다)
            player_codes: ["P3", "P4", "P9"],
          },
        ],
      };
    }
    // 기본 = 대회 전
    return {
      tournament: { name: null, round: null, status: "not_started", is_rehearsal: mockIsRehearsal() },
      leaderboard: [], groups: [],
    };
  },
};

export function liveSource(): LiveSource {
  return liveSourceMode() === "live" ? httpLiveSource : mockLiveSource;
}

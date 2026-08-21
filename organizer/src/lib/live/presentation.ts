/**
 * 라이브 화면의 **표시 규칙** — 상태 넷과 홀 표기.
 *
 * ## 🔴 두 축이다 — 진행 단계(status)와 정지 여부(stale)
 * 둘을 한 축에 합치면 `live + stale` 조합이 사라지고, 화면이 "경기가 끝났다" 고 거짓말한다.
 *
 * ## 🔴 홀보다 작은 단위를 만들지 않는다
 * 원천 오차가 **±1홀**이다(스펙 §6-3). 「그린 도착」·「페어웨이 이동 중」·도보 시간·거리를
 * 만들면 **없는 정밀도를 지어내는 것**이고, 관중은 그걸 믿고 엉뚱한 데로 간다.
 */
import type { LiveStatus } from "./types";

/**
 * 🔴 초록 LIVE 점을 켤 것인가.
 *
 * **진행 중이면서 데이터가 살아 있을 때만** 켠다. 두 축을 **모두** 본다 —
 * `status="live"` + `stale=true` 는 정상적으로 존재하는 조합이고, 그때 LIVE 를 켜면
 * 멈춘 값을 실시간이라고 말하는 것이다(관중이 잘못된 홀로 이동한다).
 */
export function isLiveIndicatorOn(status: LiveStatus, stale: boolean): boolean {
  return status === "live" && !stale;
}

export interface StateNotice {
  tone: "info" | "warn";
  title: string;
  body: string;
}

/**
 * 상태별 안내 문구. `live` 면 `null`(조용히 있는다).
 *
 * 🔴 `before` 를 반드시 만든다 — 게이트 오픈 06:00, 첫 조 출발 07:00 무렵이고
 *    **그 한 시간이 갤러리가 가장 많이 열어보는 시각**이다. 빈 목록을 그대로 보여주면
 *    고장으로 읽힌다.
 */
export function liveNotices(
  status: LiveStatus,
  stale: boolean,
  contentAgeSec: number,
): StateNotice[] {
  const out: StateNotice[] = [];

  if (status === "not_started") {
    out.push({
      tone: "info",
      title: "곧 시작합니다",
      body: "첫 조가 출발하면 조편성과 순위가 표시됩니다.",
    });
  } else if (status === "ended") {
    out.push({ tone: "info", title: "라운드가 종료되었습니다", body: "최종 순위입니다." });
  }

  // 🔴 두 축이 직교하므로 **함께** 뜰 수 있다. 진행 중인데 데이터만 멈춘 경우가 그렇다.
  if (stale) {
    out.push({
      tone: "warn",
      title: `${ageMinutes(contentAgeSec)}분 전 기준`,
      // ⚠️ 값을 지우지 않는다 — 직전 값은 그대로 보여준다. 비우면 관중이 화면을 닫는다.
      body: "갱신이 지연되고 있습니다. 아래는 마지막으로 받은 내용입니다.",
    });
  }
  return out;
}

/** 데이터 나이(초) → 분. 0분으로 안 떨어뜨린다(1분 미만도 "1분 전"). */
export function ageMinutes(contentAgeSec: number): number {
  if (!Number.isFinite(contentAgeSec) || contentAgeSec <= 0) return 0;
  return Math.max(1, Math.floor(contentAgeSec / 60));
}

/**
 * 홀 표기. **「15번홀」 이 최소 단위다.**
 *
 * ⚠️ `approx` 는 조 위치처럼 오차가 있는 값에 쓴다 — 「15번홀 부근」.
 *    그보다 자세한 표현을 이 파일 밖에서 만들지 말 것.
 */
export function formatHole(hole: number | null | undefined, approx = false): string {
  if (typeof hole !== "number" || !Number.isFinite(hole) || hole <= 0) return "-";
  return approx ? `${hole}번홀 부근` : `${hole}번홀`;
}

/** 총타수 — 언더는 `-8`, 이븐은 `E`, 오버는 `+3`. */
export function formatTotal(total: number | null | undefined): string {
  if (typeof total !== "number" || !Number.isFinite(total)) return "-";
  if (total === 0) return "E";
  return total > 0 ? `+${total}` : String(total);
}

/** 조 상태 — 필터 라벨과 같은 값을 쓴다(화면이 두 갈래로 적지 않게). */
export type GroupPhase = "playing" | "waiting" | "finished";

/**
 * 조가 어느 칸인가.
 *
 * ⚠️ `current_hole` 이 0/누락이면 **아직 안 나갔다**(출발 대기). 코스 위로 세면
 *    「지금 나가 있는 조」가 부풀고, 관중이 없는 조를 찾으러 간다.
 */
/**
 * ⚠️ `current_hole` 은 **null 일 수 있다** — 조가 아직 출발 전이면 원천이 값을 안 준다.
 *    (2026-08-07 타입 통합에서 드러났다. 옛 UI 타입이 `number` 로 선언해 숨기고 있었다.)
 */
export function groupPhase(group: { current_hole: number | null; finished: boolean }): GroupPhase {
  if (group.finished) return "finished";
  return typeof group.current_hole === "number" && group.current_hole > 0 ? "playing" : "waiting";
}

export const GROUP_PHASE_LABEL: Record<GroupPhase, string> = {
  playing: "진행 중",
  waiting: "출발 대기",
  finished: "종료",
};

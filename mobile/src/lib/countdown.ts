/**
 * 카운트다운 유틸 (Phase D.1)
 * 티켓 D-day 위젯에서 사용. 순수 함수 — 테스트 용이.
 */

export type CountdownStage =
  | "far"        // D-8 이상
  | "week"       // D-7 ~ D-4
  | "approaching" // D-3 ~ D-2
  | "tomorrow"   // D-1
  | "today"      // D-0
  | "live"       // 시작 시각 이후 24시간 이내
  | "past";      // 그 외 과거

export interface CountdownInfo {
  stage: CountdownStage;
  /** 남은 일수 (floor). D-day면 0, 지났으면 음수 */
  daysRemaining: number;
  /** 남은 시간 (시간 단위 floor). D-1 미만에서만 의미있음 */
  hoursRemaining: number;
  /** 남은 밀리초 (음수 가능) */
  msRemaining: number;
}

/** 하루 밀리초 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** 한 시간 밀리초 */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * 공연 시작 시각까지 남은 시간을 계산하고 단계 라벨을 반환.
 * @param eventDateIso ISO 문자열
 * @param nowMs 기준 시각 (테스트에서 주입)
 */
export function computeCountdown(
  eventDateIso: string | null | undefined,
  nowMs: number = Date.now(),
): CountdownInfo {
  if (!eventDateIso) {
    return { stage: "past", daysRemaining: 0, hoursRemaining: 0, msRemaining: 0 };
  }
  const target = new Date(eventDateIso).getTime();
  if (Number.isNaN(target)) {
    return { stage: "past", daysRemaining: 0, hoursRemaining: 0, msRemaining: 0 };
  }
  const msRemaining = target - nowMs;
  const daysRemaining = Math.floor(msRemaining / ONE_DAY_MS);
  const hoursRemaining = Math.floor(msRemaining / ONE_HOUR_MS);

  let stage: CountdownStage;
  if (msRemaining < -ONE_DAY_MS) stage = "past";
  else if (msRemaining < 0) stage = "live";
  else if (daysRemaining === 0) stage = "today";
  else if (daysRemaining === 1) stage = "tomorrow";
  else if (daysRemaining <= 3) stage = "approaching";
  else if (daysRemaining <= 7) stage = "week";
  else stage = "far";

  return { stage, daysRemaining, hoursRemaining, msRemaining };
}

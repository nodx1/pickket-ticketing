/**
 * F5 초대권 "입장 가능 일자" 파생 (F1 데이터 표시).
 *
 * 정본은 v2 events.admission_mode(single|daypass|allpass). go 는 발권 시 invitations 원장에
 * admission_mode·admission_day 를 스냅샷한다(211 마이그). 원장 값이 없으면(구 발권·미러 전)
 * 이벤트 기간(starts_at~ends_at)과 admission_day 유무로 안전하게 파생한다.
 *
 * - single        : 단일일 입장 — 이벤트 일자 1개.
 * - daypass + day : 지정 1일권 — 그 날짜만 입장.
 * - daypass       : 선택 1일권 — 기간 중 1일(첫 입장 시 확정).
 * - allpass       : 전일권 — 기간 내 매일 입장.
 */

import { formatDate } from "@/lib/format";

export type AdmissionMode = "single" | "daypass" | "allpass";

export interface AdmissionWindow {
  mode: AdmissionMode;
  /** 사람이 읽는 요약(예: "2025-10-16 ~ 10-19 중 1일 · 첫 입장일 확정"). */
  label: string;
  /** 짧은 배지 문구(예: "전일권"). */
  badge: string;
  /** 지정 1일권일 때 확정된 입장일(YYYY-MM-DD), 그 외 null. */
  fixedDay: string | null;
}

/** YYYY-MM-DD(KST) 로 정규화. Date/ISO 문자열 모두 허용. */
function toDayKST(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    // 이미 YYYY-MM-DD 형태면 그대로 사용.
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    return null;
  }
  // KST 로컬 날짜(UTC cast 금지 — F1 규약과 동일).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * 🔴 표시용 한국어 날짜 (2026-08-03).
 *
 * 종전에는 `YYYY-MM-DD` 를 그대로 쓰고 끝을 `slice(5)` 로 잘라
 * `"2026-08-20 ~ 08-23"` 로 보여줬다. 같은 표의 다른 두 줄은
 * `2026년 8월 20일` 형식이라 **한 화면에 세 형식이 섞였다.**
 *
 * ⚠️ 내부 판정(`start !== end` 비교 등)은 계속 `YYYY-MM-DD` 로 한다 —
 *    표시만 바꾼다. 문자열 비교를 한국어 표기로 하면 정렬·동일성이 깨진다.
 */
function displayDay(day: string): string {
  return formatDate(day) || day;
}

/**
 * 입장 규칙·이벤트 기간·지정일에서 표시용 입장 창을 파생한다.
 * mode 미상이면 admission_day 유무·기간 길이로 안전 파생.
 */
export function deriveAdmissionWindow(input: {
  mode: string | null | undefined;
  admissionDay: string | null | undefined;
  startsAt: string | Date | null | undefined;
  endsAt: string | Date | null | undefined;
}): AdmissionWindow {
  const start = toDayKST(input.startsAt);
  const end = toDayKST(input.endsAt);
  const fixedDay = toDayKST(input.admissionDay);
  const isMultiday = Boolean(start && end && start !== end);

  // 명시 모드 우선. 없으면 파생: 지정일 있으면 daypass, 다일이면 allpass, 아니면 single.
  let mode: AdmissionMode;
  if (input.mode === "single" || input.mode === "daypass" || input.mode === "allpass") {
    mode = input.mode;
  } else if (fixedDay) {
    mode = "daypass";
  } else if (isMultiday) {
    mode = "allpass";
  } else {
    mode = "single";
  }

  // 나머지 두 줄(발권일시·대회일정)과 같은 형식으로 맞춘다.
  const rangeText =
    start && end && start !== end
      ? `${displayDay(start)} ~ ${displayDay(end)}`
      : start
        ? displayDay(start)
        : "일정 미정";

  if (mode === "daypass" && fixedDay) {
    return {
      mode,
      label: `${displayDay(fixedDay)} (지정일)`,
      badge: "지정 1일권",
      fixedDay,
    };
  }

  if (mode === "daypass") {
    // 선택 1일권 — 기간 중 하루, 첫 입장 시 확정.
    return {
      mode,
      label: `${rangeText} 중 1일 · 첫 입장일 확정`,
      badge: "선택 1일권",
      fixedDay: null,
    };
  }

  if (mode === "allpass") {
    return {
      mode,
      label: `${rangeText} · 기간 내 매일 입장 가능`,
      badge: "전일권",
      fixedDay: null,
    };
  }

  // single
  return {
    mode,
    label: start ? displayDay(start) : "일정 미정",
    badge: "1일 입장",
    fixedDay: start,
  };
}

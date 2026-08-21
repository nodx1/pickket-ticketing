import { toKstParts } from "@/lib/datetime/kst-local";

/**
 * 취소 수수료 판정 — **v2 `refund_service.py` 와 같은 규칙**. 이 파일이 go 쪽 정본이다.
 *
 * ## 🔴 왜 새로 만드는가 (2026-07-31 실측)
 * 같은 정책 배열을 놓고 go 와 v2 가 **정반대**로 해석하고 있었다.
 *
 *     go  (옛 calculator.ts)  내림차순 · `days >= daysBefore`   → daysBefore = **하한**("N일 이상 남음")
 *     v2  (refund_service.py) 오름차순 · `days_left <= days_before` → days_before = **상한**("N일 이내")
 *
 * prod KLPGA 값 `[{days_before: 1, fee_pct: 100}]` 에 D-20 을 물으면
 *   · 공개 상세 표시 → "D-1 이전 0%"(환불 불가로 읽힘)
 *   · v2 소비자 환불 → 100% 환불
 *   · 주최자 환불   → 100% 환불(그나마 우연)
 * 즉 **화면과 실제 지급이 정반대**였다. 2026-07-31 오전에 고친 "화면 80% / 실지급 50%" 와
 * 같은 계열이고 부호만 뒤집혀 있었다.
 *
 * ⟹ **v2 규칙을 정본으로 삼는다.** 돈의 SSOT 가 v2 이고 소비자 환불이 이미 그 규칙으로 돈다.
 *    go 를 v2 에 맞추는 것이 바꿀 코드가 적고 되돌릴 위험도 작다.
 *
 * ## 🔴 기준시각은 "행사 시작시각" 이 아니라 "행사일 00:00 KST"
 * 대표 요구: *"행사 당일 00시까지 100% 환불"*. 시작시각(07:00)에서 일수를 세면
 * `daysLeft === 0` 구간이 **전날 07:00 부터** 시작해 자정 경계를 표현할 수 없다.
 * 행사일 자정을 기준으로 세면 `daysLeft === 0` = **행사 당일**이 정확히 떨어진다.
 *
 *     [{days_before: 0, fee_pct: 100}]
 *       → 8/20 00:00 KST 부터 수수료 100%(환불 0%)
 *       → 그 전에는 매칭 없음 → 수수료 0%(환불 100%)
 *
 * ## 매칭 규칙
 * `days_before` 오름차순으로 훑어 **처음으로 `daysLeft <= days_before` 인 단계**가 이긴다
 * (가장 촘촘한 단계). 어느 단계에도 안 걸리면 수수료 0% = 전액 환불.
 */

/** DB 저장 형태(v2 `cancellation_fee_tiers`)의 go 쪽 표현. */
export interface CancellationTier {
  /** "N일 이내" 상한. 0 = 행사 당일. */
  daysBefore: number;
  /** 취소 수수료율 0~100. 환불율은 `100 - feePct`. */
  feePct: number;
}

export interface CancellationVerdict {
  /** 환불율 0~100 */
  refundPct: number;
  /** 적용된 수수료율 0~100 */
  feePct: number;
  /** 행사일 00시까지 남은 일수(음수 = 행사일 지남) */
  daysLeft: number;
  /** 화면·로그용 라벨 */
  label: string;
  /** 매칭된 단계가 있었나(없으면 규정 밖 = 전액 환불) */
  matched: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 행사일의 **00:00 KST** 를 UTC 시각으로. 시:분:초를 버리는 것이 핵심이다.
 *
 * @returns 유효하지 않은 입력이면 `null`
 */
export function eventDayStartUtc(eventStartsAt: Date | string): Date | null {
  const iso = eventStartsAt instanceof Date ? eventStartsAt.toISOString() : eventStartsAt;
  const k = toKstParts(iso);
  if (!k) return null;
  // KST 자정 → UTC 는 전날 15:00Z.
  return new Date(Date.UTC(k.year, k.month - 1, k.day) - KST_OFFSET_MS);
}

/**
 * 행사일 00시(KST)까지 남은 **일수**. 당일이면 0, 지났으면 음수.
 *
 * ⚠️ `Math.floor` 다 — 8/19 23:59 에 물으면 남은 시간이 1분이어도 `0` 이 아니라 `0`.
 *    (8/20 00:00 이 기준이므로 8/19 23:59 는 `0`일 남음이 아니라 **아직 전날**이어야 한다)
 *    그래서 `ceil` 을 쓴다 — 자정을 넘기기 전까지는 최소 1일이 남은 것으로 센다.
 */
export function daysUntilEventDay(eventStartsAt: Date | string, now: Date): number | null {
  const dayStart = eventDayStartUtc(eventStartsAt);
  if (!dayStart) return null;
  return Math.ceil((dayStart.getTime() - now.getTime()) / DAY_MS);
}

function normalize(tiers: CancellationTier[] | null | undefined): CancellationTier[] {
  return (tiers ?? [])
    .filter((t) => Number.isFinite(t?.daysBefore) && Number.isFinite(t?.feePct))
    .map((t) => ({
      daysBefore: Math.trunc(t.daysBefore),
      feePct: Math.max(0, Math.min(100, t.feePct)),
    }))
    .sort((a, b) => a.daysBefore - b.daysBefore); // 오름차순 = 촘촘한 단계 우선
}

/**
 * 정책 + 시각 → 환불율 판정.
 *
 * 🔴 정책이 **비어 있으면 전액 환불**이다. 여기서 플랫폼 기본값을 지어내지 않는다 —
 *    주최자가 규정을 안 넣었는데 시스템이 임의 단계를 적용하면, 화면엔 "미설정" 이라
 *    쓰여 있는데 돈은 깎여 나간다(실제로 v2 가 그렇게 하고 있다 — 별건으로 정리 필요).
 */
export function judgeCancellation(
  tiers: CancellationTier[] | null | undefined,
  eventStartsAt: Date | string,
  now: Date,
): CancellationVerdict {
  const daysLeft = daysUntilEventDay(eventStartsAt, now);
  if (daysLeft === null) {
    return { refundPct: 0, feePct: 100, daysLeft: 0, label: "행사 일시 없음", matched: false };
  }

  const sorted = normalize(tiers);
  const hit = sorted.find((t) => daysLeft <= t.daysBefore);

  if (!hit) {
    return { refundPct: 100, feePct: 0, daysLeft, label: "환불 가능 기간", matched: false };
  }

  return {
    refundPct: 100 - hit.feePct,
    feePct: hit.feePct,
    daysLeft,
    label: hit.daysBefore > 0 ? `D-${hit.daysBefore} 이내` : "행사 당일",
    matched: true,
  };
}

/** v2 응답 형태(`[{days_before, fee_pct}]`) → 내부 형태. `null`·`undefined` 는 빈 배열. */
export function toTiers(
  raw: ReadonlyArray<{ days_before: number; fee_pct: number }> | null | undefined,
): CancellationTier[] {
  return (raw ?? []).map((t) => ({ daysBefore: t.days_before, feePct: t.fee_pct }));
}

/**
 * 기존 호출부가 기대하던 응답 형태로 맞춰준다(`refundAmount`·`refundPercent`·`policyLabel`·`canRefund`).
 * 화면·원장이 이 키들을 쓰고 있어 한 번에 바꾸면 표시가 깨진다.
 */
export function toLegacyPreview(v: CancellationVerdict & { refundAmount: number; canRefund: boolean }): {
  refundAmount: number;
  refundPercent: number;
  policyLabel: string;
  canRefund: boolean;
} {
  return {
    refundAmount: v.refundAmount,
    refundPercent: v.refundPct,
    policyLabel: v.label,
    canRefund: v.canRefund,
  };
}

/** 판정 + 금액. `orderTotal` 은 환불 가능 기준액(결제액 − 기환불액). */
export function calculateCancellationRefund(
  tiers: CancellationTier[] | null | undefined,
  eventStartsAt: Date | string,
  orderTotal: number,
  now: Date,
): CancellationVerdict & { refundAmount: number; canRefund: boolean } {
  const verdict = judgeCancellation(tiers, eventStartsAt, now);
  const refundAmount = Math.round((orderTotal * verdict.refundPct) / 100);
  return { ...verdict, refundAmount, canRefund: verdict.refundPct > 0 };
}

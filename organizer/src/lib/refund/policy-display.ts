/**
 * 환불 정책 **표시 문구** — 실제 지급액을 계산하는 값과 **같은 출처**에서 만든다.
 *
 * ## 🔴 왜 필요한가 (2026-07-31 실사고)
 * 공개 상세 페이지와 환불 신청 화면이 정책을 **하드코딩**하고 있었다.
 * prod 실측으로 세 값이 전부 달랐다:
 *
 *     공개 상세(하드코딩)   D-7 90% · D-3 80%
 *     환불 신청(하드코딩)   D-7 90% · D-3 80% · D-1 70%
 *     DB(실제 지급)         D-7 70% · D-3 50% · D-1 20%
 *
 * **구매자는 80% 라고 보고 50% 를 받았다.** 표시와 다른 금액을 지급하는 구조다.
 * 대회 규모가 커질수록 분쟁 소재가 된다.
 *
 * ⟹ 화면은 **DB 의 `cancellation_fee_tiers`** 만 보고 그린다. 하드코딩을 되살리지 말 것.
 *
 * ## 표시 규칙
 * DB 는 **수수료율**(`fee_pct`)을 담고 구매자가 궁금한 건 **환불율**이다 — 여기서 뒤집는다.
 * `days_before` 는 "그 날짜 이전" 경계이고 내림차순(먼 미래 → 임박)으로 보여준다.
 */

export interface CancellationTier {
  daysBefore: number;
  feePct: number;
}

export interface RefundPolicyLine {
  /** "D-7 이전" · "당일" */
  label: string;
  /** 환불율(%) = 100 - feePct */
  refundPct: number;
  /**
   * 🔴 화면에 그대로 쓰는 문구 — **"무엇의 %인지" 를 숫자에 붙여 둔다** (2026-08-01).
   *
   * 종전엔 화면이 `{label} {refundPct}%` 로만 그려서 이렇게 보였다:
   *
   *     D-1 이전  100%      ← 100% 환불? 100% 수수료?
   *     행사 당일   0%       ← 0% 환불?  0% 수수료?
   *
   * DB 는 **수수료율**(`fee_pct`)을 담고 화면은 **환불률**을 보여준다 — 뒤집힌 두 값이
   * 같은 자리에 오므로 라벨이 없으면 **정반대로 읽힌다.** 실제로 2026-07-31 에
   * "화면 80% / 실지급 50%" 계열 사고가 났던 자리다. 돈 화면에서 모호함은 분쟁이 된다.
   *
   * ⚠️ 문구를 화면이 각자 붙이면 상세와 환불신청이 갈라진다 — 여기서 한 번만 만든다.
   */
  refundLabel: string;
  /** 신호등 — 100%는 초록, 그 아래는 경고, 0%는 위험 */
  tone: "success" | "warning" | "danger";
}

function toneOf(refundPct: number): RefundPolicyLine["tone"] {
  if (refundPct >= 100) return "success";
  if (refundPct <= 0) return "danger";
  return "warning";
}

/**
 * 정책 배열 → 화면 줄 목록.
 *
 * ## 🔴 라벨이 판정과 **반대**였다 (2026-07-31 코덱스 감사에서 확정)
 * `daysBefore: 7` 을 `"D-7 이전 70%"` 로 표시했는데, 실제 판정은 `daysLeft <= 7`
 * 즉 **"D-7 이내"** 에 70% 를 적용한다. 구매자에게 **반대 구간을 고지**하고 있었다.
 *
 *     표시   "D-7 이전 70%"   → 7일보다 더 남았을 때 70% 라는 뜻으로 읽힌다
 *     실제   D-10 은 100% · D-5 가 70%
 *
 * 금액 숫자는 맞아도 **적용 구간이 틀리면 그건 틀린 고지**다. 2026-07-31 오전에
 * "화면 80% / 실지급 50%" 를 고쳤는데, 같은 날 오후에 내가 판정 규칙만 바꾸고
 * 라벨을 그대로 둬서 **같은 계열의 결함을 새로 만들었다.**
 *
 * ⟹ 이제 **실제 적용 구간**을 라벨로 만든다. `daysLeft <= daysBefore` 로 가장 촘촘한
 *    단계가 이기므로, 단계 i 의 구간은 `(이전 단계, 이 단계]` 다.
 *
 *     [{30,0},{7,30},{3,50},{1,80},{0,100}]
 *       → D-30 ~ D-8   100%
 *         D-7  ~ D-4    70%
 *         D-3  ~ D-2    50%
 *         D-1           20%
 *         행사 당일       0%
 *
 * ⚠️ 빈 배열이면 **빈 목록을 돌려준다**(가짜 기본값을 지어내지 않는다).
 *    호출부가 "환불 규정 미설정" 을 표시할지 판단한다 — 여기서 100% 라고 우기면
 *    규정을 안 넣은 행사에서 **없는 약속**을 하게 된다.
 */
export function toRefundPolicyLines(tiers: CancellationTier[] | null | undefined): RefundPolicyLine[] {
  if (!tiers || tiers.length === 0) return [];

  const sorted = [...tiers]
    .filter((t) => Number.isFinite(t.daysBefore) && Number.isFinite(t.feePct))
    .sort((a, b) => a.daysBefore - b.daysBefore); // 오름차순 = 판정 순서와 같다
  if (sorted.length === 0) return [];

  const refundOf = (feePct: number) => Math.max(0, Math.min(100, 100 - feePct));
  const lines: RefundPolicyLine[] = [];

  // 가장 바깥 구간 — 어느 단계에도 안 걸리는 기간은 **전액 환불**이다(`judgeCancellation` 의 `!hit`).
  // 이 줄이 없으면 구매자는 "언제부터 전액인지" 를 알 수 없다.
  const outermost = sorted[sorted.length - 1]!;
  if (refundOf(outermost.feePct) < 100) {
    lines.push({
      label: `D-${outermost.daysBefore + 1} 이전`,
      refundPct: 100,
      refundLabel: "환불 100%",
      tone: toneOf(100),
    });
  }

  // 각 단계의 **실제 적용 구간**을 라벨로 만든다.
  //   `daysLeft <= daysBefore` 로 가장 촘촘한 단계가 이기므로,
  //   단계 i 의 구간은 (이전 단계, 이 단계] 이다.
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const t = sorted[i]!;
    const prev = i > 0 ? sorted[i - 1]!.daysBefore : null;
    const upper = t.daysBefore;
    const lower = prev === null ? null : prev + 1;

    const isOutermost = i === sorted.length - 1;
    // 🔴 바깥 단계가 이미 전액이면 **그 위쪽도 전액**이다(어느 단계에도 안 걸리면 100%).
    //    `D-30 ~ D-3` 으로 끊어 적으면 "D-40 은 다르다" 로 읽힌다 — 실제로는 같다.
    //    ⟹ 상한을 열어 둔다. (2026-07-31 자체 대조에서 발견: tiers [30:0, 2:60, 0:100] 의
    //       남은 31일이 어떤 라벨 구간에도 안 속했다)
    const openEnded = isOutermost && refundOf(t.feePct) >= 100;

    let label: string;
    if (openEnded) label = lower === null ? "언제든" : `D-${lower} 이전`;
    else if (upper === 0) label = "행사 당일";
    else if (lower === null) label = `D-${upper} 이내`;
    else if (lower === upper) label = `D-${upper}`;
    else label = `D-${upper} ~ D-${lower}`;

    const pct = refundOf(t.feePct);
    lines.push({ label, refundPct: pct, refundLabel: `환불 ${pct}%`, tone: toneOf(pct) });
  }

  return lines;
}

/** 한 줄 요약 — 좁은 화면·목록에서 쓴다. 예: `D-30 이전 환불 100% · 당일 환불 0%` */
export function toRefundPolicySummary(tiers: CancellationTier[] | null | undefined): string {
  const lines = toRefundPolicyLines(tiers);
  if (lines.length === 0) return "환불 규정 미설정";
  return lines.map((l) => `${l.label} ${l.refundLabel}`).join(" · ");
}

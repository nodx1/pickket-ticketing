/**
 * 취소 수수료 구간을 서버 계산과 같은 방식으로 풀어 쓴다.
 *
 * 서버(refund_service.calculate_cancellation_fee_pct): 남은 일수 d 에 대해
 * `days_before >= d` 인 구간 중 days_before 가 가장 작은 구간의 수수료, 어느 구간보다 많이 남았으면 0%.
 * 그래서 [30일 0%, 7일 30%, 3일 50%, 1일 80%, 당일 100%] 는
 *   D-8 이전 무료 · D-7~D-4 30% · D-3~D-2 50% · D-1 80% · 당일 100% 이다.
 * (예전 카드는 「30일 전까지 무료 · 7일 전까지 30%」로 읽어 D-20 취소가 유료처럼 보였다.)
 */
export type FeeTier = { days_before: number; fee_pct: number };
export type FeeRow = { from: number | null; to: number; feePct: number };

/** 먼 시점 → 임박 순. from=null 이면 「D-to 이전」(그보다 먼 날 전부). */
export function feeScheduleRows(tiers: FeeTier[]): FeeRow[] {
  const asc = [...tiers].sort((a, b) => a.days_before - b.days_before);
  const rows: FeeRow[] = [];
  let lower = 0;
  for (const t of asc) {
    rows.push({ from: t.days_before, to: lower, feePct: t.fee_pct });
    lower = t.days_before + 1;
  }
  // 가장 먼 구간보다 더 남았으면 수수료 0% — 같은 0% 구간이면 하나로 합친다.
  const last = rows.at(-1);
  if (last && last.feePct === 0) last.from = null;
  else rows.push({ from: null, to: lower, feePct: 0 });
  // 표시: from(먼 쪽)~to(가까운 쪽). 같은 날이면 하나로.
  return rows.reverse().map((r) => ({ from: r.from === null ? null : r.from, to: r.to, feePct: r.feePct }));
}

/** 무료 취소가 되는 마지막 시점(행사 N일 전까지). 정책이 없으면 null. */
export function freeCancelUntilDays(tiers: FeeTier[] | null | undefined): number | null {
  if (!tiers || tiers.length === 0) return null;
  return feeScheduleRows(tiers)[0]?.to ?? null;
}

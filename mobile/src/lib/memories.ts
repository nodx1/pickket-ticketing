/**
 * memories 집계 유틸 (Phase D.3)
 *
 * 본 공연 티켓을 연도별 요약으로 변환. 순수 함수 — 테스트 용이.
 */
import type { Ticket } from "@/config/api";

export interface YearSummary {
  year: number;
  count: number;
  topCategory: string | null;
  topCategoryCount: number;
}

export function summarizeByYear(tickets: Ticket[]): YearSummary[] {
  const byYear = new Map<number, { count: number; categories: Record<string, number> }>();
  for (const t of tickets) {
    if (!t.event_date) continue;
    const y = new Date(t.event_date).getFullYear();
    if (!Number.isFinite(y)) continue;
    const entry = byYear.get(y) ?? { count: 0, categories: {} };
    entry.count += 1;
    const cat = t.event_category ?? "OTHER";
    entry.categories[cat] = (entry.categories[cat] ?? 0) + 1;
    byYear.set(y, entry);
  }
  const summaries: YearSummary[] = [];
  for (const [year, { count, categories }] of byYear) {
    let topCategory: string | null = null;
    let topCategoryCount = 0;
    for (const [cat, n] of Object.entries(categories)) {
      if (n > topCategoryCount) {
        topCategory = cat;
        topCategoryCount = n;
      }
    }
    summaries.push({ year, count, topCategory, topCategoryCount });
  }
  summaries.sort((a, b) => b.year - a.year);
  return summaries;
}

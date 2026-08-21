/**
 * memories summarizeByYear 단위 테스트 (Phase D.3)
 */
import { summarizeByYear } from "@/lib/memories";
import type { Ticket } from "@/config/api";

const mkTicket = (id: string, date: string, category?: string): Ticket =>
  ({
    id,
    event_id: `e${id}`,
    tier_id: "t1",
    seat_id: null,
    current_owner_id: "u1",
    purchase_price: 10000,
    sale_mode: "fixed",
    status: "active",
    is_resalable: false,
    transfer_count: 0,
    created_at: date,
    event_title: `show ${id}`,
    event_date: date,
    event_category: category ?? null,
  }) as Ticket;

describe("summarizeByYear", () => {
  it("빈 배열 → 빈 요약", () => {
    expect(summarizeByYear([])).toEqual([]);
  });

  it("연도별 카운트 + top 카테고리 계산", () => {
    const tickets = [
      mkTicket("1", "2025-03-01T00:00:00Z", "CONCERT"),
      mkTicket("2", "2025-06-01T00:00:00Z", "CONCERT"),
      mkTicket("3", "2025-09-01T00:00:00Z", "MUSICAL"),
      mkTicket("4", "2024-05-01T00:00:00Z", "FESTIVAL"),
    ];
    const summaries = summarizeByYear(tickets);
    expect(summaries.map((s) => s.year)).toEqual([2025, 2024]);
    expect(summaries[0].count).toBe(3);
    expect(summaries[0].topCategory).toBe("CONCERT");
    expect(summaries[0].topCategoryCount).toBe(2);
    expect(summaries[1].count).toBe(1);
    expect(summaries[1].topCategory).toBe("FESTIVAL");
  });

  it("event_date 없으면 제외", () => {
    const t: Ticket = { ...mkTicket("1", "2025-01-01T00:00:00Z", "CONCERT"), event_date: null };
    const summaries = summarizeByYear([t]);
    expect(summaries).toEqual([]);
  });
});

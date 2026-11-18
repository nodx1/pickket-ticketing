import { describe, expect, it } from "vitest";
import { ticketCheckItem } from "./ticket-check";

describe("게시 점검 — 티켓 항목", () => {
  it("자유 입장은 등급만 있으면 통과 (배치도 경고 없음)", () => {
    const r = ticketCheckItem({ tierCount: 1, publishedMapCount: 0, seatCount: 0, seatType: "unassigned" });
    expect(r.status).toBe("pass");
    expect(r.message).not.toContain("배치도가 아직");
  });
  it("자유 입장인데 등급이 없으면 실패", () => {
    expect(ticketCheckItem({ tierCount: 0, publishedMapCount: 0, seatCount: 0, seatType: "unassigned" }).status).toBe("fail");
  });
  it("지정석은 배치도가 발행돼야 통과 (기존 규칙 그대로)", () => {
    expect(ticketCheckItem({ tierCount: 2, publishedMapCount: 0, seatCount: 0, seatType: "assigned" }).status).toBe("warn");
    expect(ticketCheckItem({ tierCount: 2, publishedMapCount: 1, seatCount: 300, seatType: "assigned" }).status).toBe("pass");
    expect(ticketCheckItem({ tierCount: 2, publishedMapCount: 0, seatCount: 0 }).status).toBe("warn");
  });
});

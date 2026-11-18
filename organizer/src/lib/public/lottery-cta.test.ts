import { describe, expect, it } from "vitest";
import { isLotterySaleMode, marketEventUrl, publicCtaMode } from "./lottery-cta";

describe("피켓고 공개 페이지 — 추첨 등급 CTA", () => {
  it("추첨 등급만 있으면 피켓 응모로 연결", () => {
    expect(publicCtaMode([{ saleMode: "point_lottery", type: "ticket" }, { saleMode: "fixed_fcfs", type: "addon" }])).toBe("lottery");
  });
  it("일반 판매만 있으면 기존 구매", () => {
    expect(publicCtaMode([{ saleMode: "fixed_fcfs", type: "ticket" }])).toBe("purchase");
    expect(publicCtaMode([{ type: "ticket" }])).toBe("purchase");
  });
  it("섞여 있으면 mixed", () => {
    expect(publicCtaMode([{ saleMode: "point_lottery" }, { saleMode: "fixed_fcfs" }])).toBe("mixed");
  });
  it("팬클럽 선예매도 응모 등급", () => {
    expect(isLotterySaleMode("fanclub_presale")).toBe(true);
    expect(isLotterySaleMode("queue")).toBe(false);
  });
  it("피켓 마켓 이벤트 주소", () => {
    expect(marketEventUrl("abc", "http://localhost:3020")).toBe("http://localhost:3020/ko/events/abc");
  });
});

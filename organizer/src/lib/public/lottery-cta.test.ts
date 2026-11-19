import { describe, expect, it } from "vitest";
import { isLotterySaleMode, marketEventUrl, marketViewState, publicCtaMode } from "./lottery-cta";

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

describe("피켓고 이벤트 화면 — 피켓에서 보기", () => {
  const base = "http://localhost:3020";
  it("피켓 마켓을 켜고 승인된 이벤트는 피켓 이벤트 화면으로", () => {
    expect(marketViewState({ id: "e1", status: "bidding_open", saleChannels: ["self", "marketplace"] }, base)).toEqual({ kind: "live", url: "http://localhost:3020/ko/events/e1" });
    expect(marketViewState({ id: "e1", status: "allocated", saleChannels: ["marketplace"] }, base).kind).toBe("live");
    // 피켓고 화면이 받는 투영 상태(승인~배정 → live)
    expect(marketViewState({ id: "e1", status: "live", saleChannels: ["self", "marketplace"] }, base).kind).toBe("live");
  });
  it("승인 전이면 대기 안내", () => {
    expect(marketViewState({ id: "e1", status: "draft", saleChannels: ["marketplace"] }, base).kind).toBe("pending");
    expect(marketViewState({ id: "e1", status: "pending_review", saleChannels: ["marketplace"] }, base).kind).toBe("pending");
    expect(marketViewState({ id: "e1", status: "rejected", saleChannels: ["marketplace"] }, base).kind).toBe("pending");
  });
  it("피켓 마켓을 안 쓰면 버튼 없음", () => {
    expect(marketViewState({ id: "e1", status: "bidding_open", saleChannels: ["self"] }, base).kind).toBe("off");
    expect(marketViewState({ id: "e1", status: "bidding_open" }, base).kind).toBe("off");
  });
});

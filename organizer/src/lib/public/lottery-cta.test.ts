import { describe, expect, it } from "vitest";
import { isLotterySaleMode, marketEventsUrl, marketEventUrl, marketViewState, publicCtaMode, selfPagePreviewState } from "./lottery-cta";

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

describe("피켓고 첫 화면 — 실제 이벤트 보기", () => {
  it("피켓 이벤트 목록으로", () => {
    expect(marketEventsUrl("http://localhost:3020")).toBe("http://localhost:3020/ko/events");
  });
});

describe("피켓고 페이지 미리보기 — 공개 페이지가 열리는 상태에서만", () => {
  it("승인 뒤(live 투영값, v2 승인~배정 값)에는 연다", () => {
    for (const status of ["live", "approved", "bidding_open", "bidding_closed", "allocating", "allocated"]) {
      expect(selfPagePreviewState(status)).toEqual({ open: true });
    }
  });
  it("승인 전(작성 중·심사 중·반려)에는 막고 승인 뒤에 열린다고 알린다", () => {
    for (const status of ["draft", "pending_review", "rejected", "under_review", "revision_requested"]) {
      expect(selfPagePreviewState(status)).toEqual({ open: false, reason: "관리자 승인 뒤에 열 수 있어요." });
    }
  });
  it("판매 중지·종료에는 막고 이유를 따로 알린다", () => {
    expect(selfPagePreviewState("paused")).toEqual({ open: false, reason: "판매를 멈춘 동안에는 공개 페이지가 닫혀 있어요." });
    expect(selfPagePreviewState("archived")).toEqual({ open: false, reason: "끝난 이벤트라 공개 페이지가 닫혀 있어요." });
  });
});

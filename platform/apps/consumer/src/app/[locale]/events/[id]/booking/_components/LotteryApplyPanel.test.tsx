import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { fireEvent, render, screen } from "@testing-library/react";
import ko from "../../../../../../../messages/ko.json";
import LotteryApplyPanel from "./LotteryApplyPanel";
import type { SeatTier } from "@pickket/lib/api";

vi.mock("./MyLotteryResultCard", () => ({ default: () => null }));

const tier = (over: Partial<SeatTier>): SeatTier =>
  ({
    id: "t1", event_id: "e1", name: "갤러리 입장권", capacity: 20, base_price: 30000, sale_mode: "point_lottery",
    face_price: 30000, sold_count: 0, remaining: 20, min_price: 0, max_price_cap: 0, bidding_opens_at: null, bidding_closes_at: null,
    ...over,
  }) as SeatTier;

function renderPanel(props: Partial<Parameters<typeof LotteryApplyPanel>[0]>) {
  const onOpen = vi.fn();
  render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      <LotteryApplyPanel eventId="e1" locale="ko" eventTitle="행사" tiers={[]} sections={[]} entryCountsByTier={{}} onOpenApplyModal={onOpen} {...props} />
    </NextIntlClientProvider>,
  );
  return onOpen;
}

describe("공정추첨 응모 패널 — 자유 입장(배치도 없음)", () => {
  it("구역이 없으면 추첨 등급을 응모 대상으로 보여 주고 누르면 그 등급으로 응모 창을 연다", () => {
    const onOpen = renderPanel({ tiers: [tier({}), tier({ id: "t2", name: "주차권", sale_mode: "fixed_fcfs" })], entryCountsByTier: { t1: 9 } });
    expect(screen.getByText("응모할 입장권 선택")).toBeTruthy();
    expect(screen.queryByText("응모 가능한 구역이 없습니다")).toBeNull();
    expect(screen.queryByText("주차권")).toBeNull(); // 추첨 등급만
    fireEvent.click(screen.getByRole("button", { name: /갤러리 입장권 응모하기/ }));
    expect(onOpen).toHaveBeenCalledWith({ tier: expect.objectContaining({ id: "t1" }), sectionName: "갤러리 입장권" });
    expect(screen.getByText(/좌석 없이 입장하는 행사예요/)).toBeTruthy();
  });

  it("추첨 등급도 없으면 입장권이 없다고 안내한다", () => {
    renderPanel({ tiers: [tier({ sale_mode: "fixed_fcfs" })] });
    expect(screen.getByText("응모할 수 있는 입장권이 없습니다")).toBeTruthy();
  });

  it("응모 마감이 지나면 줄이 잠기고 눌러도 응모 창이 열리지 않는다", () => {
    const onOpen = renderPanel({ tiers: [tier({})], closesAt: new Date(Date.now() - 60_000).toISOString() });
    expect(screen.getByText(/응모가 마감됐어요/)).toBeTruthy();
    const row = screen.getByRole("button", { name: /갤러리 입장권 응모하기/ });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

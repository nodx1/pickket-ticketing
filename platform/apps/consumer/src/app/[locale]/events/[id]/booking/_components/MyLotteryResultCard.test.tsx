import { describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import ko from "../../../../../../../messages/ko.json";

const h = vi.hoisted(() => ({ entries: vi.fn(), get: vi.fn() }));
vi.mock("@pickket/lib/api", () => ({ getMyLotteryEntries: h.entries }));
vi.mock("@pickket/lib", () => ({ api: { get: h.get }, formatKRW: (n: number) => `₩${n.toLocaleString("ko-KR")}` }));

import MyLotteryResultCard from "./MyLotteryResultCard";

const won = {
  pool_id: "p1", tier_id: "t1", tier_name: "갤러리 입장권", result: "won", group_size: 1, invested_ap: 500,
  pool_status: "drawn", order_id: "o1", order_status: "payment_required",
  payment_deadline: new Date(Date.now() + 3_600_000).toISOString(), total_amount: 30000, seats: [],
};

describe("내 추첨 결과 카드", () => {
  // 🔴 예매 화면은 응모 패널을 PC·모바일 두 벌 그린다. 각자 같은 주소를 부르면 공통 API 의 중복 GET 취소가
  //    한쪽을 끊어 PC 화면의 당첨 카드(결제 버튼)가 사라졌다. 두 벌이 요청 하나를 함께 써야 한다.
  it("두 벌을 동시에 그려도 요청은 한 번이고 둘 다 당첨·결제 버튼을 보여 준다", async () => {
    h.entries.mockResolvedValue({ data: { event_id: "e1", entries: [won] } });
    h.get.mockResolvedValue({ data: { certificates: [{ cert_no: "PKT-FC-2026-000005", pool_id: "p1", tier_name: "갤러리 입장권" }] } });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <NextIntlClientProvider locale="ko" messages={ko}>
          <MyLotteryResultCard eventId="e1" locale="ko" />
          <MyLotteryResultCard eventId="e1" locale="ko" />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole("link", { name: /결제하러 가기/ })).toHaveLength(2));
    expect(screen.getAllByRole("link", { name: /결제하러 가기/ })[0].getAttribute("href")).toBe("/ko/orders/o1");
    await waitFor(() => expect(screen.getAllByText(/PKT-FC-2026-000005/)).toHaveLength(2));
    expect(h.entries).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it("대기는 낙첨이 아니라 대기로 보여 준다(결제 안 한 당첨자 몫이 순서대로 넘어간다)", async () => {
    h.entries.mockResolvedValue({ data: { event_id: "e1", entries: [{ ...won, result: "waitlisted", order_id: null, order_status: null }] } });
    h.get.mockResolvedValue({ data: { certificates: [] } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="ko" messages={ko}>
          <MyLotteryResultCard eventId="e1" locale="ko" />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/갤러리 입장권 · 대기/)).toBeTruthy());
    expect(screen.queryByText(/낙첨/)).toBeNull();
    expect(screen.getByText(/대기 순서대로 결제 기회가 넘어가요/)).toBeTruthy();
  });
});


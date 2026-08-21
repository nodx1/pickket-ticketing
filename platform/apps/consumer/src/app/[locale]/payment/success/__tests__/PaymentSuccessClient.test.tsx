import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const replaceMock = vi.fn();
const confirmMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));
vi.mock("@pickket/lib/api", () => ({
  confirmOrderPayment: (...args: unknown[]) => confirmMock(...args),
}));

import { PaymentSuccessClient } from "../PaymentSuccessClient";

describe("PaymentSuccessClient", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    confirmMock.mockReset();
  });

  it("confirm(pg_provider=toss, pg_transaction_id, payment_id, amount) 호출 후 주문상세로 이동", async () => {
    confirmMock.mockResolvedValue({ data: { status: "confirmed" } });

    render(
      <PaymentSuccessClient
        locale="ko"
        orderId="uuid-order-1"
        paymentKey="pk_toss_1"
        paymentId="ord_x_a1"
        amount={30000}
      />,
    );

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith("uuid-order-1", {
        pg_provider: "toss",
        pg_transaction_id: "pk_toss_1",
        payment_id: "ord_x_a1",
        amount: 30000,
      }),
    );
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith("/ko/orders/uuid-order-1"),
    );
  });

  it("confirm 실패 → 에러 UI 노출, 리다이렉트 안 함", async () => {
    confirmMock.mockRejectedValue({ response: { data: { detail: "카드사 거절" } } });

    render(
      <PaymentSuccessClient
        locale="ko"
        orderId="uuid-order-2"
        paymentKey="pk_x"
        paymentId=""
        amount={30000}
      />,
    );

    await waitFor(() => expect(screen.getByText("결제 승인 실패")).toBeInTheDocument());
    expect(screen.getByText("카드사 거절")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("payment_id 빈 값이면 undefined 로 전달", async () => {
    confirmMock.mockResolvedValue({ data: {} });
    render(
      <PaymentSuccessClient locale="en" orderId="o3" paymentKey="pk" paymentId="" amount={100} />,
    );
    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith("o3", {
        pg_provider: "toss",
        pg_transaction_id: "pk",
        payment_id: undefined,
        amount: 100,
      }),
    );
  });
});

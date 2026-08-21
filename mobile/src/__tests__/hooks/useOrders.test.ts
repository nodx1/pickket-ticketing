/**
 * useOrders 훅 단위 테스트
 */
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import * as api from "@/config/api";

jest.mock("@/config/api", () => ({
  getMyOrders: jest.fn(),
  getOrder: jest.fn(),
  cancelOrder: jest.fn(),
  refundOrder: jest.fn(),
  generateIdempotencyKey: jest.fn().mockReturnValue("idem-key"),
  setAuthStateResetter: jest.fn(),
}));

const mockApi = api as jest.Mocked<typeof api>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

const { useMyOrders, useOrder, useCancelOrder, useRefundOrder } =
  require("@/hooks/useOrders") as typeof import("@/hooks/useOrders");
// AUDIT §5 P0: useMyOrders에 isGuest 가드 추가 → 로그인 유저로 시뮬레이션
const { useAuthStore } = require("@/hooks/useAuth") as typeof import("@/hooks/useAuth");

const mockOrder = {
  id: "order-1",
  event_id: "event-1",
  status: "confirmed",
  total_amount: 66000,
  quantity: 1,
  tier_name: "R석",
  event_title: "Test Concert",
  created_at: "2026-04-01T00:00:00Z",
};

describe("useOrders hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ user: null, isGuest: false, isLoading: false });
  });

  describe("useMyOrders", () => {
    it("내 주문 목록 로드", async () => {
      mockApi.getMyOrders.mockResolvedValue([mockOrder] as never);

      const { result } = renderHook(() => useMyOrders(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data![0].id).toBe("order-1");
    });

    it("status 필터 전달", async () => {
      mockApi.getMyOrders.mockResolvedValue([] as never);

      const { result } = renderHook(
        () => useMyOrders({ status: "confirmed" }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.getMyOrders).toHaveBeenCalledWith({ status: "confirmed" });
    });
  });

  describe("useOrder", () => {
    it("주문 상세 로드", async () => {
      mockApi.getOrder.mockResolvedValue(mockOrder as never);

      const { result } = renderHook(() => useOrder("order-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(mockOrder);
    });

    it("빈 ID → 쿼리 비활성화", () => {
      const { result } = renderHook(() => useOrder(""), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("useCancelOrder", () => {
    it("주문 취소 성공", async () => {
      mockApi.cancelOrder.mockResolvedValue(undefined as never);

      const { result } = renderHook(() => useCancelOrder(), {
        wrapper: createWrapper(),
      });

      result.current.mutate("order-1");

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.cancelOrder).toHaveBeenCalledWith("order-1");
    });
  });

  describe("useRefundOrder", () => {
    it("환불 요청 성공", async () => {
      mockApi.refundOrder.mockResolvedValue(undefined as never);

      const { result } = renderHook(() => useRefundOrder(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        orderId: "order-1",
        reason: "User request",
        amount: 66000,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.refundOrder).toHaveBeenCalledWith("order-1", {
        reason: "User request",
        amount: 66000,
        idempotency_key: "idem-key",
      });
    });
  });
});

/**
 * usePurchase 훅 단위 테스트
 */
import { renderHook, waitFor } from "@testing-library/react-native";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as api from "@/config/api";
import { storage } from "@/lib/storage";

jest.mock("@/config/api", () => ({
  purchaseTicket: jest.fn(),
  purchaseFanclub: jest.fn(),
  generateIdempotencyKey: jest.fn().mockReturnValue("idem-key-123"),
}));

jest.mock("@/lib/storage", () => ({
  storage: {
    get: jest.fn(),
    set: jest.fn(),
    remove: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;
const mockStorage = storage as jest.Mocked<typeof storage>;

import { usePurchaseTicket, usePurchaseFanclub } from "@/hooks/usePurchase";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
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

describe("usePurchase", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.get.mockResolvedValue(null);
    mockStorage.set.mockResolvedValue(undefined);
    mockStorage.remove.mockResolvedValue(undefined);
  });

  describe("usePurchaseTicket", () => {
    it("구매 성공 시 멱등키 생성 + API 호출 + 키 삭제", async () => {
      const purchaseResult = {
        order_id: "ord-1",
        status: "completed",
        processing: false,
      };
      mockApi.purchaseTicket.mockResolvedValue(purchaseResult as never);

      const { result } = renderHook(() => usePurchaseTicket(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        eventId: "ev-1",
        tierId: "tier-1",
        quantity: 2,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApi.generateIdempotencyKey).toHaveBeenCalled();
      expect(mockApi.purchaseTicket).toHaveBeenCalledWith("ev-1", "tier-1", {
        quantity: 2,
        idempotency_key: "idem-key-123",
        seat_ids: undefined,
        queue_token: undefined,
      });
      // 성공 시 멱등키 삭제 (quantity 포함)
      expect(mockStorage.remove).toHaveBeenCalledWith("idem_purchase_ev-1_tier-1_2");
    });

    it("기존 멱등키 있으면 재사용", async () => {
      mockStorage.get.mockResolvedValue("existing-key");
      mockApi.purchaseTicket.mockResolvedValue({ order_id: "ord-2", processing: false } as never);

      const { result } = renderHook(() => usePurchaseTicket(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        eventId: "ev-1",
        tierId: "tier-1",
        quantity: 1,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApi.generateIdempotencyKey).not.toHaveBeenCalled();
      expect(mockApi.purchaseTicket).toHaveBeenCalledWith(
        "ev-1",
        "tier-1",
        expect.objectContaining({ idempotency_key: "existing-key" }),
      );
    });

    it("API 에러 시 mutation 실패", async () => {
      mockApi.purchaseTicket.mockRejectedValue(new Error("Server Error"));

      const { result } = renderHook(() => usePurchaseTicket(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        eventId: "ev-1",
        tierId: "tier-1",
        quantity: 1,
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    it("seatIds + queueToken 전달", async () => {
      mockApi.purchaseTicket.mockResolvedValue({ order_id: "ord-3", processing: false } as never);

      const { result } = renderHook(() => usePurchaseTicket(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        eventId: "ev-1",
        tierId: "tier-1",
        quantity: 1,
        seatIds: ["A1", "A2"],
        queueToken: "qt-123",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApi.purchaseTicket).toHaveBeenCalledWith(
        "ev-1",
        "tier-1",
        expect.objectContaining({
          seat_ids: ["A1", "A2"],
          queue_token: "qt-123",
        }),
      );
    });
  });

  describe("usePurchaseFanclub", () => {
    it("팬클럽 구매 성공", async () => {
      mockApi.purchaseFanclub.mockResolvedValue({
        order_id: "ord-fc-1",
        processing: false,
      } as never);

      const { result } = renderHook(() => usePurchaseFanclub(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        eventId: "ev-2",
        tierId: "tier-fc",
        quantity: 1,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApi.purchaseFanclub).toHaveBeenCalledWith("ev-2", "tier-fc", {
        quantity: 1,
        idempotency_key: "idem-key-123",
        seat_ids: undefined,
        queue_token: undefined,
      });
      expect(mockStorage.remove).toHaveBeenCalledWith("idem_purchase_ev-2_tier-fc_1");
    });

    it("팬클럽 구매 실패 시 에러", async () => {
      mockApi.purchaseFanclub.mockRejectedValue(new Error("Sold out"));

      const { result } = renderHook(() => usePurchaseFanclub(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        eventId: "ev-2",
        tierId: "tier-fc",
        quantity: 1,
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
    });
  });
});

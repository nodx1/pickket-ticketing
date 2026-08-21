/**
 * useLottery 훅 단위 테스트
 */
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import * as api from "@/config/api";

jest.mock("@/config/api", () => ({
  applyLottery: jest.fn(),
  getLotteryStatus: jest.fn(),
  getMyLotteryResult: jest.fn(),
  getMyEventStatus: jest.fn(),
  getMyResult: jest.fn(),
  getPointBalance: jest.fn(),
  getTotalPoints: jest.fn().mockReturnValue(100),
  setAuthStateResetter: jest.fn(),
}));

const mockApi = api as jest.Mocked<typeof api>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
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

const {
  useLotteryStatus,
  useApplyLottery,
  useMyLotteryResult,
  useMyEventStatus,
  useMyResult,
} = require("@/hooks/useLottery") as typeof import("@/hooks/useLottery");
// AUDIT §5 P0: useMy* 훅에 isGuest 가드 추가 → 로그인 유저로 시뮬레이션
const { useAuthStore } = require("@/hooks/useAuth") as typeof import("@/hooks/useAuth");

describe("useLottery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ user: null, isGuest: false, isLoading: false });
  });

  describe("useLotteryStatus", () => {
    it("티어별 추첨 풀 조회", async () => {
      mockApi.getLotteryStatus.mockResolvedValue({
        applied_count: 100,
        capacity: 50,
      } as never);

      const { result } = renderHook(
        () => useLotteryStatus("ev-1", "tier-1"),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.getLotteryStatus).toHaveBeenCalledWith("ev-1", "tier-1");
    });

    it("ID 없으면 비활성화", () => {
      const { result } = renderHook(() => useLotteryStatus("", ""), {
        wrapper: createWrapper(),
      });
      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("useApplyLottery", () => {
    it("응모 호출", async () => {
      mockApi.applyLottery.mockResolvedValue({ pool_id: "pool-1" } as never);

      const { result } = renderHook(
        () => useApplyLottery("ev-1", "tier-1"),
        { wrapper: createWrapper() },
      );

      act(() => {
        result.current.mutate({ bid_amount: 100 } as never);
      });

      await waitFor(() =>
        expect(mockApi.applyLottery).toHaveBeenCalledWith(
          "ev-1",
          "tier-1",
          { bid_amount: 100 },
        ),
      );
    });
  });

  describe("useMyEventStatus", () => {
    it("내 이벤트 상태 조회", async () => {
      mockApi.getMyEventStatus.mockResolvedValue({
        has_ticket: false,
        ticket_count: 0,
        has_lottery_entry: true,
        lottery_status: "applied",
        lottery_entry_id: "entry-1",
        invested_ap: 100,
        lottery_tier_id: "tier-1",
        lottery_pool_id: "pool-1",
        lottery_group_size: 1,
      } as never);

      const { result } = renderHook(() => useMyEventStatus("ev-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.has_lottery_entry).toBe(true);
    });
  });

  describe("useMyResult", () => {
    it("배분 결과 조회 (enabled=true)", async () => {
      mockApi.getMyResult.mockResolvedValue({ won: true, fair_price: 50000 } as never);

      const { result } = renderHook(() => useMyResult("ev-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it("enabled=false → 호출 안 됨", () => {
      renderHook(() => useMyResult("ev-1", false), {
        wrapper: createWrapper(),
      });

      expect(mockApi.getMyResult).not.toHaveBeenCalled();
    });
  });

  describe("useMyLotteryResult", () => {
    it("풀별 결과 조회", async () => {
      mockApi.getMyLotteryResult.mockResolvedValue({ won: true } as never);

      const { result } = renderHook(() => useMyLotteryResult("pool-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.getMyLotteryResult).toHaveBeenCalledWith("pool-1");
    });
  });
});

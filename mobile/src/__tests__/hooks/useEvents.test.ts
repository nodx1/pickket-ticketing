/**
 * useEvents 훅 단위 테스트
 */
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import * as api from "@/config/api";

jest.mock("@/config/api", () => ({
  getFeaturedEvents: jest.fn(),
  getTrendingEvents: jest.fn(),
  getEventDetail: jest.fn(),
  getEventTiers: jest.fn(),
  getSimilarEvents: jest.fn(),
  searchEvents: jest.fn(),
  toggleFavorite: jest.fn(),
  getRecommendations: jest.fn(),
  setAuthStateResetter: jest.fn(),
}));

const mockApi = api as jest.Mocked<typeof api>;

// React Query wrapper
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

// Import after mocks
const { useFeaturedEvents, useTrendingEvents, useEvent, useEventTiers } =
  require("@/hooks/useEvents") as typeof import("@/hooks/useEvents");

const mockEvent = {
  id: "event-1",
  title: "NewJeans 2026 월드 투어 서울",
  image_url: null,
  venue: "올림픽공원",
  event_date: "2026-09-29T19:55:00Z",
  category: "CONCERT",
  status: "on_sale",
  min_price: 66000,
  bid_count: 0,
  is_featured: true,
  organizer_name: "빅히트",
  location_city: "서울",
  thumbnail_url: null,
  primary_sale_mode: "fixed_fcfs",
};

const mockTier = {
  id: "tier-1",
  event_id: "event-1",
  name: "R석",
  capacity: 1050,
  base_price: 66000,
  sale_mode: "fixed_fcfs",
  face_price: 66000,
  sold_count: 0,
  remaining: 1050,
  max_group_size: 4,
  seating_type: "assigned",
};

describe("useEvents hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("useFeaturedEvents", () => {
    it("피처드 이벤트 로드 성공", async () => {
      mockApi.getFeaturedEvents.mockResolvedValue([mockEvent] as never);

      const { result } = renderHook(() => useFeaturedEvents(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toHaveLength(1);
      expect(result.current.data![0].title).toBe("NewJeans 2026 월드 투어 서울");
    });

    it("API 에러 시 에러 상태", async () => {
      mockApi.getFeaturedEvents.mockRejectedValue(new Error("Network Error"));

      const { result } = renderHook(() => useFeaturedEvents(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
    });
  });

  describe("useTrendingEvents", () => {
    it("트렌딩 이벤트 로드", async () => {
      mockApi.getTrendingEvents.mockResolvedValue([mockEvent] as never);

      const { result } = renderHook(() => useTrendingEvents(10), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.getTrendingEvents).toHaveBeenCalledWith(10);
    });
  });

  describe("useEvent", () => {
    it("이벤트 상세 로드", async () => {
      mockApi.getEventDetail.mockResolvedValue({ ...mockEvent, description: "테스트 설명" } as never);

      const { result } = renderHook(() => useEvent("event-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.title).toBe("NewJeans 2026 월드 투어 서울");
    });

    it("빈 ID → 쿼리 비활성화", () => {
      const { result } = renderHook(() => useEvent(""), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("useEventTiers", () => {
    it("티어 로드 성공", async () => {
      mockApi.getEventTiers.mockResolvedValue([mockTier] as never);

      const { result } = renderHook(() => useEventTiers("event-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data![0].name).toBe("R석");
      expect(result.current.data![0].base_price).toBe(66000);
    });
  });
});

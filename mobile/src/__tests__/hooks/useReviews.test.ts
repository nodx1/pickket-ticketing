/**
 * useReviews 훅 단위 테스트
 */
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import * as api from "@/config/api";

jest.mock("@/config/api", () => ({
  getEventReviews: jest.fn(),
  getReviewSummary: jest.fn(),
  createReview: jest.fn(),
  markReviewHelpful: jest.fn(),
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
  useEventReviews,
  useReviewSummary,
  useCreateReview,
  useMarkHelpful,
} = require("@/hooks/useReviews") as typeof import("@/hooks/useReviews");
// AUDIT §5 P0: useEventReviews/useReviewSummary에 isGuest 가드 추가
const { useAuthStore } = require("@/hooks/useAuth") as typeof import("@/hooks/useAuth");

describe("useReviews", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ user: null, isGuest: false, isLoading: false });
  });

  describe("useEventReviews", () => {
    it("리뷰 목록 로드", async () => {
      mockApi.getEventReviews.mockResolvedValue({
        reviews: [{ id: "r-1", rating: 5 }],
        total: 1,
      } as never);

      const { result } = renderHook(() => useEventReviews("ev-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.getEventReviews).toHaveBeenCalledWith("ev-1", 0, 20);
    });

    it("빈 ID → 비활성화", () => {
      const { result } = renderHook(() => useEventReviews(""), {
        wrapper: createWrapper(),
      });
      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("useReviewSummary", () => {
    it("요약 로드", async () => {
      mockApi.getReviewSummary.mockResolvedValue({
        average_rating: 4.5,
        total_reviews: 10,
        rating_distribution: { 5: 7, 4: 3 },
      } as never);

      const { result } = renderHook(() => useReviewSummary("ev-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.average_rating).toBe(4.5);
    });
  });

  describe("useCreateReview", () => {
    it("리뷰 작성 → API 호출", async () => {
      mockApi.createReview.mockResolvedValue({ id: "r-1" } as never);

      const { result } = renderHook(() => useCreateReview("ev-1"), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.mutate({
          rating: 5,
          title: "최고",
          content: "정말 좋았어요",
        });
      });

      await waitFor(() =>
        expect(mockApi.createReview).toHaveBeenCalledWith("ev-1", {
          rating: 5,
          title: "최고",
          content: "정말 좋았어요",
        }),
      );
    });
  });

  describe("useMarkHelpful", () => {
    it("도움됨 마크 → API 호출", async () => {
      mockApi.markReviewHelpful.mockResolvedValue({ helpful_count: 1 } as never);

      const { result } = renderHook(() => useMarkHelpful("ev-1"), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.mutate("r-1");
      });

      await waitFor(() =>
        expect(mockApi.markReviewHelpful).toHaveBeenCalledWith("ev-1", "r-1"),
      );
    });
  });
});

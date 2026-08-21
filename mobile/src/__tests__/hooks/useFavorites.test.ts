/**
 * useFavorites 훅 단위 테스트
 */
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import * as api from "@/config/api";
import { useAuthStore } from "@/hooks/useAuth";

jest.mock("@/config/api", () => ({
  getMyFavorites: jest.fn(),
  toggleFavorite: jest.fn(),
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

// AUDIT 2026-04-20 §5 P0: useToggleFavorite는 useEvents.ts로 일원화됨.
// useFavorites는 useMyFavorites만 export.
const { useMyFavorites } =
  require("@/hooks/useFavorites") as typeof import("@/hooks/useFavorites");
const { useToggleFavorite } =
  require("@/hooks/useEvents") as typeof import("@/hooks/useEvents");

describe("useFavorites", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // isGuest=false 강제 — 로그인 유저가 훅을 호출하는 경로 시뮬레이션
    useAuthStore.setState({ user: null, isGuest: false, isLoading: false });
  });

  it("내 즐겨찾기 목록 로드", async () => {
    mockApi.getMyFavorites.mockResolvedValue([
      { id: "ev-1", title: "Concert" },
    ] as never);

    const { result } = renderHook(() => useMyFavorites(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it("즐겨찾기 토글 → API 호출", async () => {
    mockApi.toggleFavorite.mockResolvedValue({ favorited: true } as never);

    const { result } = renderHook(() => useToggleFavorite(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate("ev-1");
    });

    await waitFor(() =>
      expect(mockApi.toggleFavorite).toHaveBeenCalledWith("ev-1"),
    );
  });

  it("API 에러 → 에러 상태", async () => {
    mockApi.getMyFavorites.mockRejectedValue(new Error("Network"));

    const { result } = renderHook(() => useMyFavorites(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

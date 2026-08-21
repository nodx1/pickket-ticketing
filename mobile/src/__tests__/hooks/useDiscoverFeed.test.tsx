/**
 * useDiscoverFeed 단위 테스트 (Phase A.4)
 *
 * 검증:
 * 1. 첫 페이지 로드 → events 평탄화
 * 2. fetchNextPage → cursor 전달 + 누적 events
 * 3. next_cursor=null 이면 hasNextPage=false
 * 4. 다음 페이지 이미지 prefetch 호출
 */
import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockGetDiscoverFeed = jest.fn();
const mockPrefetch = jest.fn();

jest.mock("@/config/api", () => ({
  getDiscoverFeed: (...args: unknown[]) => mockGetDiscoverFeed(...args),
}));

jest.mock("expo-image", () => ({
  Image: {
    prefetch: (...args: unknown[]) => mockPrefetch(...args),
  },
}));

import { useDiscoverFeed } from "@/hooks/useDiscoverFeed";

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const evt = (id: string) => ({
  id,
  title: `Event ${id}`,
  event_date: "2030-01-01",
  status: "on_sale",
  image_url: `https://example.com/${id}.jpg`,
});

describe("useDiscoverFeed", () => {
  beforeEach(() => {
    mockGetDiscoverFeed.mockReset();
    mockPrefetch.mockReset();
    mockPrefetch.mockResolvedValue(undefined);
  });

  it("첫 페이지 로드 → events 평탄화", async () => {
    mockGetDiscoverFeed.mockResolvedValueOnce({
      events: [evt("a"), evt("b")],
      next_cursor: "next",
    });

    const { result } = renderHook(() => useDiscoverFeed(10), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[0].id).toBe("a");
    expect(result.current.hasNextPage).toBe(true);
  });

  it("fetchNextPage → cursor 전달 + 누적", async () => {
    mockGetDiscoverFeed
      .mockResolvedValueOnce({ events: [evt("a")], next_cursor: "p2" })
      .mockResolvedValueOnce({ events: [evt("b")], next_cursor: null });

    const { result } = renderHook(() => useDiscoverFeed(10), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.events).toHaveLength(1));

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(mockGetDiscoverFeed).toHaveBeenNthCalledWith(2, "p2", 10, undefined);
    expect(result.current.hasNextPage).toBe(false);
  });

  it("다음 페이지 이미지 prefetch 호출", async () => {
    mockGetDiscoverFeed.mockResolvedValueOnce({
      events: [evt("a"), evt("b")],
      next_cursor: null,
    });

    const { result } = renderHook(() => useDiscoverFeed(10), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.events).toHaveLength(2));

    expect(mockPrefetch).toHaveBeenCalledWith([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
    ]);
  });
});

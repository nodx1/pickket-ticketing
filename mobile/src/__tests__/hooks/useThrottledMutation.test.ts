/**
 * useThrottledMutation 단위 테스트 — 연타 방지 검증
 */
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

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

const { useThrottledMutation } =
  require("@/hooks/useThrottledMutation") as typeof import("@/hooks/useThrottledMutation");

describe("useThrottledMutation", () => {
  let mockFn: jest.Mock;

  beforeEach(() => {
    mockFn = jest.fn().mockResolvedValue("ok");
  });

  it("첫 호출은 즉시 실행", async () => {
    const { result } = renderHook(
      () => useThrottledMutation({ mutationFn: mockFn }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.mutate("test");
    });

    await waitFor(() => {
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
    expect(mockFn.mock.calls[0][0]).toBe("test");
  });

  it("1초 내 연타 차단", async () => {
    let now = 1000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const { result } = renderHook(
      () => useThrottledMutation({ mutationFn: mockFn }),
      { wrapper: createWrapper() },
    );

    // 첫 호출: t=1000
    act(() => {
      result.current.mutate("call-1");
    });
    await waitFor(() => {
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    // 500ms 후: t=1500 → 차단
    now = 1500;
    act(() => {
      result.current.mutate("call-2");
    });

    // 999ms: t=1999 → 여전히 차단
    now = 1999;
    act(() => {
      result.current.mutate("call-3");
    });

    // 여전히 1번만 호출
    expect(mockFn).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, "now").mockRestore();
  });

  it("1초 후 다시 호출 가능", async () => {
    let now = 1000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const { result } = renderHook(
      () => useThrottledMutation({ mutationFn: mockFn }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.mutate("call-1");
    });
    await waitFor(() => {
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    // 1001ms 후
    now = 2001;
    act(() => {
      result.current.mutate("call-2");
    });
    await waitFor(() => {
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
    expect(mockFn.mock.calls[1][0]).toBe("call-2");

    jest.spyOn(Date, "now").mockRestore();
  });

  it("커스텀 throttle 간격 적용 (2초)", async () => {
    // lastCallRef 초기값 0이므로 첫 호출 통과를 위해 now는 throttleMs(2000) 이상
    let now = 10_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const { result } = renderHook(
      () => useThrottledMutation({ mutationFn: mockFn }, 2000),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.mutate("call-1");
    });
    await waitFor(() => {
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    // 1500ms 후 → 차단 (2초 미만)
    now = 11_500;
    act(() => {
      result.current.mutate("call-2");
    });
    expect(mockFn).toHaveBeenCalledTimes(1);

    // 2001ms 후 → 허용
    now = 12_001;
    act(() => {
      result.current.mutate("call-3");
    });
    await waitFor(() => {
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    jest.spyOn(Date, "now").mockRestore();
  });

  // AUDIT §5 P0: mutateAsync도 throttle 적용 검증
  it("mutateAsync도 throttle 간격 내 호출 차단", async () => {
    let now = 10_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    const { result } = renderHook(
      () => useThrottledMutation({ mutationFn: mockFn }),
      { wrapper: createWrapper() },
    );

    // 첫 호출: 통과
    await act(async () => {
      await result.current.mutateAsync("call-1" as string);
    });
    expect(mockFn).toHaveBeenCalledTimes(1);

    // 500ms 후: 차단 (Throttled 에러)
    now = 10_500;
    await act(async () => {
      await expect(result.current.mutateAsync("call-2" as string)).rejects.toThrow("Throttled");
    });
    expect(mockFn).toHaveBeenCalledTimes(1);

    // 1001ms 후: 통과
    now = 11_001;
    await act(async () => {
      await result.current.mutateAsync("call-3" as string);
    });
    expect(mockFn).toHaveBeenCalledTimes(2);

    jest.spyOn(Date, "now").mockRestore();
  });
});

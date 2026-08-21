import { QueryClient } from "@tanstack/react-query";

/**
 * 멱등 mutation만 재시도 (네트워크 에러, 5xx). 4xx는 재시도 불필요.
 *
 * NOTE: axios `isAxiosError`를 top-level import 하지 않는다.
 * jest-expo ios preset에서 axios fetch adapter 로드가 ReadableStream.cancel()
 * 을 트리거해 테스트 모듈 로드 자체가 실패함. duck typing으로 우회.
 */
type MaybeAxiosError = {
  isAxiosError?: boolean;
  response?: { status?: number };
};

function shouldRetryMutation(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  const axiosErr = error as MaybeAxiosError | null;
  if (axiosErr?.isAxiosError) {
    // 네트워크 에러 또는 서버 에러만 재시도
    if (!axiosErr.response) return true; // 네트워크 끊김
    const status = axiosErr.response.status ?? 0;
    return status >= 500 || status === 429;
  }
  return false;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5분
      gcTime: 30 * 60 * 1000, // 30분 (캐시 GC)
      retry: 2,
      refetchOnWindowFocus: false, // 모바일: AppState로 별도 처리
      refetchOnReconnect: "always", // 네트워크 복구 시 stale 쿼리 갱신
    },
    mutations: {
      retry: shouldRetryMutation,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    },
  },
});

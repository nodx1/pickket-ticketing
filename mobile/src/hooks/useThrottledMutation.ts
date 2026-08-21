/**
 * Throttled useMutation 래퍼
 *
 * 버튼 연타 방지: mutate() 호출 간 최소 간격(기본 1초) 강제.
 * 기존 useMutation과 동일한 인터페이스에 throttle만 추가.
 */
import { useRef, useCallback } from "react";
import { useMutation, type UseMutationOptions, type UseMutationResult } from "@tanstack/react-query";

const DEFAULT_THROTTLE_MS = 1000;

export function useThrottledMutation<TData, TError, TVariables, TContext>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
  throttleMs = DEFAULT_THROTTLE_MS,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const lastCallRef = useRef(0);
  const mutation = useMutation(options);

  const throttledMutate = useCallback(
    (variables: TVariables, mutateOptions?: Parameters<typeof mutation.mutate>[1]) => {
      const now = Date.now();
      if (now - lastCallRef.current < throttleMs) return;
      lastCallRef.current = now;
      mutation.mutate(variables, mutateOptions);
    },
    [mutation.mutate, throttleMs],
  );

  // AUDIT §5 P0: mutateAsync도 동일한 throttle 적용 — async 경유 연타 방지
  const throttledMutateAsync = useCallback(
    (variables: TVariables, mutateOptions?: Parameters<typeof mutation.mutateAsync>[1]) => {
      const now = Date.now();
      if (now - lastCallRef.current < throttleMs) {
        return Promise.reject(new Error("Throttled"));
      }
      lastCallRef.current = now;
      return mutation.mutateAsync(variables, mutateOptions);
    },
    [mutation.mutateAsync, throttleMs],
  );

  return {
    ...mutation,
    mutate: throttledMutate as typeof mutation.mutate,
    mutateAsync: throttledMutateAsync as typeof mutation.mutateAsync,
  };
}

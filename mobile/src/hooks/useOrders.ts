/**
 * 주문 관련 React Query 훅
 */
import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useThrottledMutation } from "./useThrottledMutation";
import { useAuthStore } from "@/hooks/useAuth";
import {
  getMyOrders,
  getOrder,
  cancelOrder,
  refundOrder,
  generateIdempotencyKey,
} from "@/config/api";
import { queryKeys } from "@/config/queryKeys";

export function useMyOrders(params?: { status?: string; event_id?: string }) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: queryKeys.orders.my(params),
    queryFn: () => getMyOrders(params),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

export function useOrder(orderId: string) {
  return useQuery({
    queryKey: queryKeys.orders.detail(orderId),
    queryFn: () => getOrder(orderId),
    enabled: !!orderId,
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();

  return useThrottledMutation({
    mutationFn: (orderId: string) => cancelOrder(orderId),
    onSuccess: (_data, orderId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all });
    },
  });
}

export function useRefundOrder() {
  const queryClient = useQueryClient();
  // 멱등키는 mutate 호출당 1회(onMutate)만 생성해 ref 에 보관한다. mutationFn 내부에서 생성하면
  // React Query 재시도(네트워크/5xx)마다 새 키가 발급돼 서버 멱등성을 무력화 → 이중환불(P2-C18).
  // onMutate 는 재시도 시 재실행되지 않으므로 키가 한 호출 동안 고정된다.
  const idempotencyKeyRef = useRef<string>("");

  return useThrottledMutation({
    onMutate: () => {
      idempotencyKeyRef.current = generateIdempotencyKey();
    },
    mutationFn: ({ orderId, reason, amount }: { orderId: string; reason: string; amount?: number }) =>
      refundOrder(orderId, {
        reason,
        amount,
        idempotency_key: idempotencyKeyRef.current,
      }),
    onSuccess: (_data, { orderId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all });
    },
  });
}

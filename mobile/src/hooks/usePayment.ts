/**
 * 결제 관련 React Query 훅
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  prepareOrderPayment,
  confirmOrderPayment,
} from "@/config/api";

export function usePreparePayment() {
  return useMutation({
    mutationFn: ({
      orderId,
      idempotencyKey,
      successUrl,
      failUrl,
    }: {
      orderId: string;
      idempotencyKey?: string;
      successUrl?: string;
      failUrl?: string;
    }) =>
      prepareOrderPayment(orderId, {
        idempotency_key: idempotencyKey,
        success_url: successUrl,
        fail_url: failUrl,
      }),
  });
}

export function useConfirmPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      orderId,
      pgProvider,
      pgTransactionId,
      paymentId,
      amount,
      idempotencyKey,
    }: {
      orderId: string;
      pgProvider: string;
      pgTransactionId: string;
      paymentId?: string;
      amount?: number;
      idempotencyKey?: string;
    }) =>
      confirmOrderPayment(orderId, {
        pg_provider: pgProvider,
        pg_transaction_id: pgTransactionId,
        payment_id: paymentId,
        amount,
      }, idempotencyKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
}

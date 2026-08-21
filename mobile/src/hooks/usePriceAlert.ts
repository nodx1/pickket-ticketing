/**
 * Phase E.2 — 가격 알림 훅
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/hooks/useAuth";
import {
  createPriceAlert,
  deletePriceAlert,
  getMyPriceAlerts,
  type PriceAlert,
} from "@/config/api";

export function useMyPriceAlerts(includeTriggered = false) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery<PriceAlert[]>({
    queryKey: ["price-alerts", { includeTriggered }],
    queryFn: () => getMyPriceAlerts(includeTriggered),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

export function useCreatePriceAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { eventId: string; tierId: string; targetPrice: number }) =>
      createPriceAlert(input.eventId, input.tierId, input.targetPrice),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-alerts"] });
    },
  });
}

export function useDeletePriceAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) => deletePriceAlert(alertId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["price-alerts"] });
    },
  });
}

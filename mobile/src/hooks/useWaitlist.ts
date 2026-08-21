/**
 * 대기열(Waitlist) 관련 React Query 훅
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { joinWaitlist, getWaitlistStatus, leaveWaitlist } from "@/config/api";
import { queryKeys } from "@/config/queryKeys";

export function useWaitlistStatus(eventId: string, tierId: string) {
  return useQuery({
    queryKey: queryKeys.waitlist.status(eventId, tierId),
    queryFn: () => getWaitlistStatus(eventId, tierId),
    enabled: !!eventId && !!tierId,
    refetchInterval: 10_000,
  });
}

export function useJoinWaitlist(eventId: string, tierId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (quantity: number) => joinWaitlist(eventId, tierId, quantity),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.waitlist.detail(eventId, tierId) });
    },
  });
}

export function useLeaveWaitlist(eventId: string, tierId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => leaveWaitlist(eventId, tierId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.waitlist.detail(eventId, tierId) });
    },
  });
}

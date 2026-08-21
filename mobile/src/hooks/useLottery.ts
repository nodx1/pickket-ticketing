/**
 * 복권(Lottery) 관련 React Query 훅
 * v2 web consumer LotteryWidget 기반
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useThrottledMutation } from "./useThrottledMutation";
import { useAuthStore } from "@/hooks/useAuth";
import {
  applyLottery,
  getLotteryStatus,
  getMyLotteryResult,
  getMyEventStatus,
  getMyResult,
  type LotteryApplyRequest,
} from "@/config/api";

/** 티어별 추첨 풀 현황 */
export function useLotteryStatus(eventId: string, tierId: string) {
  return useQuery({
    queryKey: ["lottery", eventId, tierId, "status"],
    queryFn: () => getLotteryStatus(eventId, tierId),
    enabled: !!eventId && !!tierId,
  });
}

/** 추첨 신청 */
export function useApplyLottery(eventId: string, tierId: string) {
  const queryClient = useQueryClient();

  return useThrottledMutation({
    mutationFn: (params: LotteryApplyRequest) => applyLottery(eventId, tierId, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lottery", eventId, tierId] });
      queryClient.invalidateQueries({ queryKey: ["myEventStatus", eventId] });
    },
  });
}

/** 풀별 개인 결과 (pool_id 기반) */
export function useMyLotteryResult(poolId: string) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: ["lottery", "result", poolId],
    queryFn: () => getMyLotteryResult(poolId),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !!poolId && !isGuest,
  });
}

/** 이벤트에 대한 내 상태 (이미 응모했는지, 티켓 있는지) */
export function useMyEventStatus(eventId: string) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: ["myEventStatus", eventId],
    queryFn: () => getMyEventStatus(eventId),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !!eventId && !isGuest,
  });
}

/** 이벤트 배분 결과 (당첨/미당첨 + 공정 배분가) */
export function useMyResult(eventId: string, enabled = true) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: ["myResult", eventId],
    queryFn: () => getMyResult(eventId),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !!eventId && enabled && !isGuest,
  });
}


/**
 * Phase F.3 — Points (Fan / Social AP) 조회 훅
 * 기존 /points/balance, /points/history 엔드포인트만 사용 (백엔드 추가 없음)
 */
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/hooks/useAuth";
import { getPointBalance, getPointHistory } from "@/config/api";
import { queryKeys } from "@/config/queryKeys";

export function usePointBalance() {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: queryKeys.points.balance(),
    queryFn: getPointBalance,
    staleTime: 60_000,
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

export function usePointHistory(limit = 50, offset = 0) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: queryKeys.points.history(limit, offset),
    queryFn: () => getPointHistory(limit, offset),
    staleTime: 60_000,
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

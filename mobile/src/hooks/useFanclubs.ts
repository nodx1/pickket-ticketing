/**
 * Phase F.2 — Fanclub 멤버십 (= "내 멤버십") 조회 훅
 * 기존 GET /users/me/fanclubs 재사용
 */
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/hooks/useAuth";
import { getMyFanclubMemberships } from "@/config/api";

export function useMyFanclubs() {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: ["fanclubs", "my"],
    queryFn: getMyFanclubMemberships,
    staleTime: 60_000,
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

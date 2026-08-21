import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/hooks/useAuth";
import { getFanProfile } from "@/config/api";
import type { FanProfile } from "@/types/fan";

export function useFanProfile() {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery<FanProfile>({
    queryKey: ["fan-profile"],
    queryFn: getFanProfile,
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

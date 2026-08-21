/**
 * 즐겨찾기 관련 React Query 훅
 *
 * AUDIT 2026-04-20 §5 P0: useToggleFavorite는 useEvents.ts로 일원화.
 * 과거 이 파일 버전은 broad `["events"]` invalidate로 featured/trending/search/detail
 * 리페치 캐스케이드를 유발했음. 이제 import 경로는 `@/hooks/useEvents`만 사용.
 */
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/hooks/useAuth";
import { getMyFavorites } from "@/config/api";

export function useMyFavorites() {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: ["favorites"],
    queryFn: getMyFavorites,
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

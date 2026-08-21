/**
 * Picks(픽) React Query 훅 — 생성/조회/삭제 + Mock 폴백
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getFanStamps,
  createFanStamp,
  deleteFanStamp,
} from "@/config/api";
import { useAuthStore } from "@/hooks/useAuth";
import type { FanStamp, PickStatus } from "@/types/fan-stamp";
import { MOCK_PICKS } from "@/data/mock-picks";

/** 내 픽 전체 목록 */
export function usePicks() {
  const isGuest = useAuthStore((s) => s.isGuest);

  return useQuery<FanStamp[]>({
    queryKey: ["picks"],
    queryFn: async () => {
      try {
        return await getFanStamps();
      } catch (_err: unknown) {
        // 백엔드 미준비 시 mock 폴백 (__DEV__ only)
        if (__DEV__) return MOCK_PICKS;
        throw _err;
      }
    },
    enabled: !isGuest,
    staleTime: 60_000,
  });
}

/** 특정 이벤트의 픽 목록 (클라이언트 사이드 필터) */
export function usePicksByEvent(eventId: string) {
  const { data: allPicks, ...rest } = usePicks();

  const picks = allPicks?.filter((p) => p.eventId === eventId) ?? [];

  return { picks, ...rest };
}

/** 픽 생성 뮤테이션 */
export function useCreatePick() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      eventId,
      imageUri,
      status = "completed" as PickStatus,
    }: {
      eventId: string;
      imageUri: string;
      status?: PickStatus;
    }) => createFanStamp(eventId, imageUri, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["picks"] });
    },
  });
}

/** 픽 삭제 뮤테이션 */
export function useDeletePick() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (pickId: string) => deleteFanStamp(pickId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["picks"] });
    },
  });
}

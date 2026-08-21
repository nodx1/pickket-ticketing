/**
 * 이벤트 관련 React Query 훅
 */
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useThrottledMutation } from "./useThrottledMutation";
import {
  getFeaturedEvents,
  getTrendingEvents,
  getEventDetail,
  getEventTiers,
  getSimilarEvents,
  searchEvents,
  toggleFavorite,
  getRecommendations,
  type EventSearchParams,
  type EventDetail,
  type Event,
} from "@/config/api";
import { queryKeys } from "@/config/queryKeys";

export function useFeaturedEvents() {
  return useQuery({
    queryKey: queryKeys.events.featured(),
    queryFn: getFeaturedEvents,
  });
}

export function useTrendingEvents(limit = 10) {
  return useQuery({
    queryKey: queryKeys.events.trending(limit),
    queryFn: () => getTrendingEvents(limit),
  });
}

export function useEvent(id: string) {
  return useQuery({
    queryKey: queryKeys.events.detail(id),
    queryFn: () => getEventDetail(id),
    enabled: !!id,
  });
}

export function useEventTiers(eventId: string) {
  return useQuery({
    queryKey: queryKeys.events.tiers(eventId),
    queryFn: () => getEventTiers(eventId),
    enabled: !!eventId,
  });
}

export function useSimilarEvents(eventId: string) {
  return useQuery({
    queryKey: queryKeys.events.similar(eventId),
    queryFn: () => getSimilarEvents(eventId),
    enabled: !!eventId,
  });
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();

  return useThrottledMutation({
    mutationFn: (eventId: string) => toggleFavorite(eventId),
    // AUDIT 2026-05-28 §5 P1: optimistic update — 즉시 하트 토글
    onMutate: async (eventId: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.events.detail(eventId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.favorites.all });

      const prevDetail = queryClient.getQueryData<EventDetail>(queryKeys.events.detail(eventId));
      const prevFavorites = queryClient.getQueryData<Event[]>(queryKeys.favorites.all);

      if (prevDetail) {
        queryClient.setQueryData<EventDetail>(queryKeys.events.detail(eventId), {
          ...prevDetail,
          is_favorited: !prevDetail.is_favorited,
        });
      }

      if (prevFavorites) {
        const isFav = prevFavorites.some((e) => e.id === eventId);
        if (isFav) {
          queryClient.setQueryData<Event[]>(
            queryKeys.favorites.all,
            prevFavorites.filter((e) => e.id !== eventId),
          );
        }
      }

      return { prevDetail, prevFavorites };
    },
    onError: (_err, eventId, context) => {
      if (context?.prevDetail) {
        queryClient.setQueryData(queryKeys.events.detail(eventId), context.prevDetail);
      }
      if (context?.prevFavorites) {
        queryClient.setQueryData(queryKeys.favorites.all, context.prevFavorites);
      }
    },
    onSettled: (_data, _err, eventId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.events.detail(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.favorites.all });
    },
  });
}

export function useRecommendations(limit = 10, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.recommendations.list(limit),
    queryFn: () => getRecommendations(limit),
    enabled: options?.enabled ?? true,
  });
}

export function useSearchEvents(params: EventSearchParams, options?: { enabled?: boolean }) {
  const limit = params.limit ?? 20;

  return useInfiniteQuery({
    queryKey: queryKeys.events.search(params),
    queryFn: ({ pageParam = 0 }) =>
      searchEvents({ ...params, skip: pageParam, limit }),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.events.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    initialPageParam: 0,
    enabled: options?.enabled ?? true,
  });
}

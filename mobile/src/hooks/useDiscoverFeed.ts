/**
 * useDiscoverFeed — Discover 피드 무한 스크롤 (Phase A.4 + Phase 2 category)
 *
 * - cursor 기반 페이지네이션 (getDiscoverFeed)
 * - 마지막 페이지 도달 시 next_cursor=null → fetchNextPage 무효화
 * - 다음 페이지 이미지 prefetch
 * - category 필터 지원 (백엔드 미지원 시 클라이언트 사이드 폴백)
 */
import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { getDiscoverFeed, type Event, type DiscoverFeedPage } from "@/config/api";

const PAGE_SIZE = 10;

export function useDiscoverFeed(limit = PAGE_SIZE, category?: string) {
  const query = useInfiniteQuery<DiscoverFeedPage>({
    queryKey: ["discover", "feed", limit, category],
    queryFn: ({ pageParam }) => getDiscoverFeed(pageParam as string | undefined, limit, category),
    initialPageParam: undefined,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.next_cursor) return undefined;
      // 백엔드가 offset을 무시해 같은 이벤트만 반복 반환할 경우 중복 감지로 종료
      if (allPages.length > 1) {
        const prevIds = new Set(
          allPages.slice(0, -1).flatMap((p) => p.events.map((e) => e.id)),
        );
        const hasNew = lastPage.events.some((e) => !prevIds.has(e.id));
        if (!hasNew) return undefined;
      }
      return lastPage.next_cursor;
    },
    staleTime: 60_000,
  });

  const events = useMemo<Event[]>(() => {
    const all = query.data?.pages.flatMap((p) => p.events) ?? [];
    const seen = new Set<string>();
    const unique: Event[] = [];
    for (const e of all) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      unique.push(e);
    }
    // 클라이언트 사이드 폴백: 백엔드가 category 파라미터를 무시한 경우 필터링
    if (category) {
      return unique.filter(
        (e) => e.category?.toLowerCase() === category.toLowerCase(),
      );
    }
    return unique;
  }, [query.data, category]);

  // 다음 페이지 이미지 prefetch (성능)
  useEffect(() => {
    const lastPage = query.data?.pages.at(-1);
    if (!lastPage) return;
    const urls = lastPage.events
      .map((e) => e.hero_video_url ?? e.image_url ?? e.thumbnail_url)
      .filter((u): u is string => typeof u === "string");
    if (urls.length > 0) {
      Image.prefetch(urls).catch(() => {});
    }
  }, [query.data]);

  return {
    events,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
  };
}

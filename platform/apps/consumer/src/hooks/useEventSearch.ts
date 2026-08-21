import { useInfiniteQuery } from "@tanstack/react-query";
import {
  searchEvents,
  type SearchParams,
  type EventSearchResponse,
} from "@pickket/lib/api";

const PAGE_SIZE = 12;

export { PAGE_SIZE };

export function useEventSearch(
  filters: SearchParams,
  initialData?: EventSearchResponse,
) {
  return useInfiniteQuery<EventSearchResponse>({
    queryKey: ["events", "search", filters],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await searchEvents({
        ...filters,
        skip: pageParam as number,
        limit: PAGE_SIZE,
      });
      return res.data;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.events.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    initialData: initialData
      ? { pages: [initialData], pageParams: [0] }
      : undefined,
    staleTime: 5 * 60 * 1000,
  });
}

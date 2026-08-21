/**
 * AI 디스커버 검색 훅
 */
import { useQuery } from "@tanstack/react-query";
import { discover } from "@/config/api";

export function useDiscover(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ["discover", query],
    queryFn: () => discover(query),
    enabled: enabled && query.length > 0,
    staleTime: 1000 * 60 * 5,
  });
}

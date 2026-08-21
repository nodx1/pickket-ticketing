/**
 * useFriends — 친구 시스템 React Query 훅 (Phase C.1)
 *
 * 백엔드 미구현 시 graceful empty fallback (api.ts에서 처리)
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/hooks/useAuth";
import {
  acceptFriend,
  getFriendsList,
  removeFriend,
  requestFriend,
  searchUsers,
  type FriendsListResponse,
  type User,
} from "@/config/api";

const FRIENDS_KEY = ["friends", "list"] as const;

export function useFriendsList() {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery<FriendsListResponse>({
    queryKey: FRIENDS_KEY,
    queryFn: getFriendsList,
    staleTime: 60_000,
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

export function useUserSearch(query: string) {
  return useQuery<User[]>({
    queryKey: ["users", "search", query],
    queryFn: () => searchUsers(query),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });
}

export function useRequestFriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: requestFriend,
    onSuccess: () => qc.invalidateQueries({ queryKey: FRIENDS_KEY }),
  });
}

export function useAcceptFriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: acceptFriend,
    onSuccess: () => qc.invalidateQueries({ queryKey: FRIENDS_KEY }),
  });
}

export function useRemoveFriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: removeFriend,
    onSuccess: () => qc.invalidateQueries({ queryKey: FRIENDS_KEY }),
  });
}

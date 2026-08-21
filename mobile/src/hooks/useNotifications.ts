/**
 * 알림 관련 React Query 훅
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/hooks/useAuth";
import {
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from "@/config/api";
import { queryKeys } from "@/config/queryKeys";

export function useNotifications(params?: { unread_only?: boolean; skip?: number; limit?: number }) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: queryKeys.notifications.list(params),
    queryFn: () => getNotifications(params),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

export function useUnreadCount() {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: getUnreadNotificationCount,
    // AUDIT 2026-04-20 §5 P0: guests must not poll user-scoped data
    enabled: !isGuest,
    refetchInterval: isGuest ? false : 30_000,
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (notificationId: string) => markNotificationRead(notificationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useNotificationPreferences() {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: queryKeys.notifications.preferences(),
    queryFn: getNotificationPreferences,
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !isGuest,
  });
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (prefs: Partial<NotificationPreferences>) => updateNotificationPreferences(prefs),
    onSuccess: (data) => {
      queryClient.setQueryData(["notifications", "preferences"], data);
    },
  });
}

/**
 * 대기열 관련 React Query 훅
 */
import { useState, useEffect } from "react";
import { AppState } from "react-native";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  joinQueue,
  getQueueStatus,
  leaveQueue,
  getQueueStats,
} from "@/config/api";
import { queryKeys } from "@/config/queryKeys";

export function useJoinQueue() {
  return useMutation({
    mutationFn: (eventId: string) => joinQueue(eventId),
  });
}

export function useQueueStatus(eventId: string, enabled = false) {
  const [appActive, setAppActive] = useState(
    () => AppState.currentState === "active",
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      setAppActive(s === "active");
    });
    return () => sub.remove();
  }, []);

  return useQuery({
    queryKey: queryKeys.queue.status(eventId),
    queryFn: () => getQueueStatus(eventId),
    enabled: enabled && !!eventId,
    refetchInterval: appActive ? 3000 : false,
  });
}

export function useLeaveQueue() {
  return useMutation({
    mutationFn: (eventId: string) => leaveQueue(eventId),
  });
}

export function useQueueStats(eventId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.queue.stats(eventId),
    queryFn: () => getQueueStats(eventId),
    enabled: enabled && !!eventId,
    staleTime: 10000,
  });
}

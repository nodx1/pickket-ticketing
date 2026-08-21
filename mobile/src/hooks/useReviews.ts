/**
 * 리뷰 관련 React Query 훅
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useThrottledMutation } from "./useThrottledMutation";
import { useAuthStore } from "@/hooks/useAuth";
import {
  getEventReviews,
  getReviewSummary,
  createReview,
  markReviewHelpful,
} from "@/config/api";

export function useEventReviews(eventId: string, skip = 0, limit = 20) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: ["reviews", eventId, skip, limit],
    queryFn: () => getEventReviews(eventId, skip, limit),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !!eventId && !isGuest,
  });
}

export function useReviewSummary(eventId: string) {
  const isGuest = useAuthStore((s) => s.isGuest);
  return useQuery({
    queryKey: ["reviews", eventId, "summary"],
    queryFn: () => getReviewSummary(eventId),
    // AUDIT 2026-04-20 §5 P0: guests must not fetch user-scoped data
    enabled: !!eventId && !isGuest,
  });
}

export function useCreateReview(eventId: string) {
  const queryClient = useQueryClient();

  return useThrottledMutation({
    mutationFn: (params: { rating: number; title: string; content: string }) =>
      createReview(eventId, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reviews", eventId] });
    },
  });
}

export function useMarkHelpful(eventId: string) {
  const queryClient = useQueryClient();

  return useThrottledMutation({
    mutationFn: (reviewId: string) => markReviewHelpful(eventId, reviewId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reviews", eventId] });
    },
  });
}

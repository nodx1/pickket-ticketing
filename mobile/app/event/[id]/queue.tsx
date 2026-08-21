/**
 * 대기열 화면
 *
 * v2 queue flow:
 *   1. POST /events/{eventId}/queue/join → QueueJoinResponse (position, token)
 *   2. GET /events/{eventId}/queue/status → 3초 폴링 (position, is_active, token)
 *   3. is_active=true + token → booking 화면으로 자동 이동 (queue_token 전달)
 *   4. POST /events/{eventId}/queue/leave → 이탈
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { View, Text, Alert, AppState, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useEvent } from "@/hooks/useEvents";
import { useJoinQueue, useQueueStatus, useLeaveQueue } from "@/hooks/useQueue";
import { Button } from "@/components/ui/Button";
import { formatEventDate } from "@/lib/format";

export default function QueueScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const eventId = typeof params.id === "string" ? params.id : params.id?.[0] ?? "";

  const { data: event } = useEvent(eventId);
  const joinMutation = useJoinQueue();
  const leaveMutation = useLeaveQueue();

  const [isInQueue, setIsInQueue] = useState(false);
  const hasNavigated = useRef(false);
  // Strict Mode 이중 마운트 방지 ref — 첫 번째 호출만 실행하고 두 번째는 스킵(P2-C17)
  const hasJoined = useRef(false);

  // Poll queue status when in queue
  const { data: status } = useQueueStatus(eventId, isInQueue);

  const navigateToBooking = useCallback(
    (token: string) => {
      if (hasNavigated.current) return;
      hasNavigated.current = true;
      router.replace({
        pathname: "/event/[id]/booking",
        params: { id: eventId, queueToken: token },
      });
    },
    [eventId, router],
  );

  // Join queue on mount — ref guard로 Strict Mode 이중 마운트 시 2회 호출 방지(P2-C17).
  // joinMutation.mutate는 안정 참조이므로 아래 의존 배열에 포함해도 무한 재실행 없음.
  const joinMutationRef = useRef(joinMutation);
  joinMutationRef.current = joinMutation;
  const navigateToBookingRef = useRef(navigateToBooking);
  navigateToBookingRef.current = navigateToBooking;
  const tRef = useRef(t);
  tRef.current = t;
  const routerRef = useRef(router);
  routerRef.current = router;
  useEffect(() => {
    if (hasJoined.current) return;
    hasJoined.current = true;
    joinMutationRef.current.mutate(eventId, {
      onSuccess: (result) => {
        setIsInQueue(true);
        if (result.is_active && result.token) {
          navigateToBookingRef.current(result.token);
        }
      },
      onError: (error: Error) => {
        Alert.alert(tRef.current("common.error"), error.message, [
          { text: tRef.current("common.confirm"), onPress: () => routerRef.current.back() },
        ]);
      },
    });
  }, [eventId]);

  // Watch for activation via polling
  useEffect(() => {
    if (status?.is_active && status.token && !hasNavigated.current) {
      navigateToBooking(status.token);
    }
  }, [status?.is_active, status?.token, navigateToBooking]);

  // Re-check on app foreground
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && isInQueue) {
        // Status query will auto-refetch due to refetchInterval
      }
    });
    return () => sub.remove();
  }, [isInQueue]);

  const handleLeave = useCallback(() => {
    Alert.alert(t("queue.leaveConfirm"), "", [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.confirm"),
        style: "destructive",
        onPress: () => {
          leaveMutation.mutate(eventId, {
            onSuccess: () => router.back(),
            onError: () => router.back(),
          });
        },
      },
    ]);
  }, [eventId, leaveMutation, router, t]);

  const estimatedMinutes = status
    ? Math.max(1, Math.ceil(status.estimated_wait_seconds / 60))
    : null;

  // Progress (rough): lower position = closer to front
  const progress = status && status.total_waiting > 0
    ? Math.max(0.05, 1 - status.position / status.total_waiting)
    : 0;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("queue.waiting") }} />

      <View style={styles.content}>
        {/* Event info */}
        {event && (
          <View style={[styles.eventCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[typography.h4, { color: colors.foreground }]} numberOfLines={1}>
              {event.title}
            </Text>
            {event.event_date && (
              <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                {formatEventDate(event.event_date)}
              </Text>
            )}
          </View>
        )}

        {/* Queue status */}
        {joinMutation.isPending ? (
          <Text style={[typography.body, { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.xxl }]}>
            {t("queue.joining")}
          </Text>
        ) : status ? (
          <View style={styles.statusSection}>
            {/* Circular progress indicator */}
            <View style={[styles.progressCircle, { borderColor: colors.border }]}>
              <View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: status.is_active ? colors.success : colors.primary,
                    transform: [{ scale: progress }],
                  },
                ]}
              />
              <View style={styles.progressContent}>
                <Text style={[typography.h1, { color: status.is_active ? colors.success : colors.foreground }]}>
                  {status.is_active ? "✓" : `#${status.position}`}
                </Text>
              </View>
            </View>

            {status.is_active ? (
              <Text style={[typography.h3, { color: colors.success, textAlign: "center", marginTop: spacing.xl }]}>
                {t("queue.yourTurn")}
              </Text>
            ) : (
              <>
                <Text style={[typography.h3, { color: colors.foreground, textAlign: "center", marginTop: spacing.xl }]}>
                  {t("queue.position", { position: status.position })}
                </Text>
                <Text style={[typography.body, { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.sm }]}>
                  {t("queue.totalWaiting", { count: status.total_waiting })}
                </Text>
                {estimatedMinutes && (
                  <Text style={[typography.body, { color: colors.violet, textAlign: "center", marginTop: spacing.sm }]}>
                    {t("queue.estimatedMinutes", { minutes: estimatedMinutes })}
                  </Text>
                )}
              </>
            )}
          </View>
        ) : isInQueue ? (
          /* join 성공 후 첫 폴링 응답 도착 전 — 빈 화면 방지(P2-C16) */
          <Text style={[typography.body, { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.xxl }]}>
            {t("queue.joining")}
          </Text>
        ) : null}
      </View>

      {/* Leave button */}
      {isInQueue && !status?.is_active && (
        <View style={[styles.bottomBar, { borderColor: colors.border }]}>
          <Button
            title={t("queue.leave")}
            onPress={handleLeave}
            variant="outline"
            size="lg"
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    padding: spacing.xl,
  },
  eventCard: {
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  statusSection: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  progressCircle: {
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  progressFill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 80,
    opacity: 0.15,
  },
  progressContent: {
    alignItems: "center",
    justifyContent: "center",
  },
  bottomBar: {
    padding: spacing.xl,
    borderTopWidth: 1,
  },
});

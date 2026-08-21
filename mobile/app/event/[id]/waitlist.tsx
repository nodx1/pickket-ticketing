/**
 * 취소표 대기(Waitlist) 화면
 * 매진 이벤트에서 취소표 대기 참가
 */
import { useCallback } from "react";
import { View, Text, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useEvent } from "@/hooks/useEvents";
import { useWaitlistStatus, useJoinWaitlist, useLeaveWaitlist } from "@/hooks/useWaitlist";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatEventDate } from "@/lib/format";

export default function WaitlistScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; tierId: string; tierName: string }>();
  const eventId = typeof params.id === "string" ? params.id : params.id?.[0] ?? "";
  const tierId = typeof params.tierId === "string" ? params.tierId : "";
  const tierName = typeof params.tierName === "string" ? params.tierName : "";

  const { data: event } = useEvent(eventId);
  const { data: status, isLoading } = useWaitlistStatus(eventId, tierId);
  const joinMutation = useJoinWaitlist(eventId, tierId);
  const leaveMutation = useLeaveWaitlist(eventId, tierId);

  const isJoined = !!status?.my_entry;

  const handleJoin = useCallback(() => {
    joinMutation.mutate(1, {
      onSuccess: () => {
        Alert.alert(t("waitlist.joined"), t("waitlist.joinedMessage"));
      },
      onError: (error: Error) => {
        Alert.alert(t("common.error"), error.message);
      },
    });
  }, [joinMutation, t]);

  const handleLeave = useCallback(() => {
    Alert.alert(t("waitlist.leaveConfirm"), "", [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.confirm"),
        style: "destructive",
        onPress: () => {
          leaveMutation.mutate(undefined, {
            onSuccess: () => router.back(),
            onError: (error: Error) => {
              Alert.alert(t("common.error"), error.message);
            },
          });
        },
      },
    ]);
  }, [leaveMutation, router, t]);

  const statusLabel = status?.my_entry?.status
    ? t(`waitlist.status.${status.my_entry.status}`)
    : "";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("waitlist.title") }} />

      <View style={styles.body}>
        {/* 이벤트 요약 */}
        {event && (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[typography.h4, { color: colors.foreground }]} numberOfLines={2}>
              {event.title}
            </Text>
            {event.event_date && (
              <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                {formatEventDate(event.event_date)}
              </Text>
            )}
            {tierName && <Badge label={tierName} variant="outline" style={{ marginTop: spacing.sm }} />}
          </View>
        )}

        {/* 대기 현황 */}
        {isLoading ? (
          <Skeleton width="100%" height={120} borderRadius={radius.md} style={{ marginTop: spacing.lg }} />
        ) : (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: spacing.lg }]}>
            <Text style={[typography.h4, { color: colors.foreground }]}>{t("waitlist.currentStatus")}</Text>

            <View style={[styles.statsRow, { marginTop: spacing.md }]}>
              <View style={styles.statItem}>
                <Text style={[typography.h2, { color: colors.primary }]}>{status?.total_waiting ?? 0}</Text>
                <Text style={[typography.micro, { color: colors.mutedForeground }]}>{t("waitlist.totalWaiting")}</Text>
              </View>
              {status?.my_position != null && (
                <View style={styles.statItem}>
                  <Text style={[typography.h2, { color: colors.warning }]}>{status.my_position}</Text>
                  <Text style={[typography.micro, { color: colors.mutedForeground }]}>{t("waitlist.myPosition")}</Text>
                </View>
              )}
            </View>

            {isJoined && statusLabel && (
              <Badge
                label={statusLabel}
                variant={status?.my_entry?.status === "offered" ? "success" : "outline"}
                style={{ marginTop: spacing.md }}
              />
            )}
          </View>
        )}

        {/* 안내 */}
        <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.lg }]}>
          {t("waitlist.description")}
        </Text>

        {/* 액션 */}
        <View style={{ marginTop: spacing.xl }}>
          {isJoined ? (
            <Button
              title={leaveMutation.isPending ? t("booking.processing") : t("waitlist.leave")}
              variant="destructive"
              onPress={handleLeave}
              disabled={leaveMutation.isPending}
              size="xl"
            />
          ) : (
            <Button
              title={joinMutation.isPending ? t("booking.processing") : t("waitlist.join")}
              onPress={handleJoin}
              disabled={joinMutation.isPending}
              size="xl"
            />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: { padding: spacing.xl },
  card: {
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  statItem: {
    alignItems: "center",
  },
});

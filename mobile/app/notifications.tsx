/**
 * 알림 목록 화면
 * 읽음/안읽음 구분 + 날짜별 그룹핑 + 전체 읽음 처리
 */
import { useCallback } from "react";
import { View, Text, FlatList, TouchableOpacity, RefreshControl, StyleSheet } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useNotifications, useMarkRead, useMarkAllRead } from "@/hooks/useNotifications";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import i18n from "@/i18n";
import { Button } from "@/components/ui/Button";
import type { NotificationItem } from "@/config/api";

function getNotificationRoute(item: NotificationItem): string | null {
  const data = item.data;
  if (!data) return null;
  if (data.event_id) return `/event/${data.event_id}`;
  if (data.ticket_id) return `/ticket/${data.ticket_id}`;
  if (data.order_id) return `/order/${data.order_id}`;
  return null;
}

export default function NotificationsScreen() {
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const router = useRouter();

  const { data, isLoading, isError, refetch, isRefetching } = useNotifications();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unread_count ?? 0;

  const handlePress = useCallback(
    (item: NotificationItem) => {
      if (!item.is_read) {
        markRead.mutate(item.id);
      }
      const route = getNotificationRoute(item);
      if (route) {
        router.push(route as never);
      }
    },
    [markRead, router],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: NotificationItem; index: number }) => (
      <Animated.View entering={FadeInDown.springify().delay(index * 40)}>
        <TouchableOpacity
          style={[
            styles.notifCard,
            {
              backgroundColor: item.is_read ? colors.card : colors.surface,
              borderColor: colors.border,
              shadowColor: isDark ? "transparent" : "#000",
            },
          ]}
          onPress={() => handlePress(item)}
          activeOpacity={0.7}
          accessibilityLabel={item.message}
          accessibilityRole="button"
        >
          {!item.is_read && <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />}
          <View style={styles.notifContent}>
            <Text style={[typography.body, { color: colors.foreground }]} numberOfLines={2}>
              {item.message}
            </Text>
            <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
              {new Date(item.created_at).toLocaleString(i18n.language?.startsWith("ko") ? "ko-KR" : "en-US")}
            </Text>
          </View>
        </TouchableOpacity>
      </Animated.View>
    ),
    [colors, isDark, handlePress],
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("notification.title") }} />

      {/* 전체 읽음 */}
      {unreadCount > 0 && (
        <View style={styles.headerAction}>
          <Button
            title={t("notification.markAllRead")}
            onPress={() => markAllRead.mutate()}
            variant="outline"
            size="sm"
          />
        </View>
      )}

      {isLoading ? (
        <View style={styles.skeleton}>
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} width="100%" height={72} borderRadius={16} style={{ marginBottom: spacing.md }} />
          ))}
        </View>
      ) : isError ? (
        <EmptyState
          title={t("common.error")}
          message={t("common.serverError")}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      ) : notifications.length === 0 ? (
        <EmptyState title={t("notification.empty")} />
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          windowSize={7}
          initialNumToRender={8}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerAction: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    alignItems: "flex-end",
  },
  skeleton: {
    padding: spacing.xl,
  },
  listContent: {
    padding: spacing.xl,
    gap: spacing.md,
  },
  notifCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    marginRight: spacing.sm,
  },
  notifContent: {
    flex: 1,
  },
});

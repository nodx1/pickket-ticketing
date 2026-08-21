/**
 * 주문 내역 화면
 * 날짜 역순, 상태 뱃지 표시
 */
import { useCallback } from "react";
import { View, Text, FlatList, TouchableOpacity, RefreshControl, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useMyOrders } from "@/hooks/useOrders";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { formatKRW } from "@/lib/format";
import i18n from "@/i18n";
import { ORDER_STATUS } from "@/constants/status";
import type { OrderDetail } from "@/config/api";

function getOrderStatusLabel(status: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    [ORDER_STATUS.CONFIRMED]: t("order.status.confirmed"),
    [ORDER_STATUS.PAID]: t("order.status.confirmed"),
    [ORDER_STATUS.REFUNDED]: t("order.status.refunded"),
    [ORDER_STATUS.CANCELLED]: t("order.status.cancelled"),
    [ORDER_STATUS.PAYMENT_REQUIRED]: t("order.status.paymentRequired"),
    [ORDER_STATUS.PARTIALLY_REFUNDED]: t("order.status.partiallyRefunded"),
    [ORDER_STATUS.AUTHORIZED]: t("order.status.authorized"),
    [ORDER_STATUS.PENDING]: t("order.status.pending"),
    [ORDER_STATUS.EXPIRED]: t("order.status.expired"),
  };
  return map[status] ?? status;
}

function getOrderStatusVariant(status: string): "default" | "destructive" | "outline" {
  switch (status) {
    case ORDER_STATUS.CONFIRMED:
    case ORDER_STATUS.PAID:
      return "default";
    case ORDER_STATUS.CANCELLED:
    case ORDER_STATUS.REFUNDED:
      return "destructive";
    default:
      return "outline";
  }
}

export default function OrdersScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  const { data: orders, isLoading, isError, refetch, isRefetching } = useMyOrders();

  const renderItem = useCallback(({ item }: { item: OrderDetail }) => (
    <TouchableOpacity
      testID={`order.card.${item.id}`}
      style={[styles.orderCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={() => router.push(`/order/${item.id}`)}
      activeOpacity={0.7}
      accessibilityLabel={`${t("order.myOrders")} ${formatKRW(item.total_amount)} ${getOrderStatusLabel(item.status, t)}`}
      accessibilityRole="button"
    >
      <View style={styles.orderHeader}>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
          {new Date(item.created_at).toLocaleDateString(i18n.language?.startsWith("ko") ? "ko-KR" : "en-US")}
        </Text>
        <Badge
          label={getOrderStatusLabel(item.status, t)}
          variant={getOrderStatusVariant(item.status)}
        />
      </View>

      <View style={styles.orderBody}>
        <Text style={[typography.body, { color: colors.foreground }]}>
          {item.quantity}매 × {formatKRW(item.unit_price)}
        </Text>
        <Text style={[typography.h4, { color: colors.primary }]}>
          {formatKRW(item.total_amount)}
        </Text>
      </View>

      <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]} numberOfLines={1}>
        ID: {item.id.slice(0, 8)}...
      </Text>
    </TouchableOpacity>
  ), [colors, router, t]);

  return (
    <SafeAreaView testID="orders.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("order.myOrders") }} />

      {isLoading ? (
        <View style={styles.skeleton}>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} width="100%" height={90} borderRadius={16} style={{ marginBottom: spacing.md }} />
          ))}
        </View>
      ) : isError ? (
        <EmptyState
          title={t("common.error")}
          message={t("common.serverError")}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      ) : !orders || orders.length === 0 ? (
        <EmptyState title={t("common.noResults")} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          windowSize={7}
          initialNumToRender={8}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  skeleton: {
    padding: spacing.xl,
  },
  listContent: {
    padding: spacing.xl,
    gap: spacing.md,
  },
  orderCard: {
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  orderHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  orderBody: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.sm,
  },
});

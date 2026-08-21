/**
 * 주문 상세 화면
 * 이벤트 정보 + 결제 금액 + 상태 + 환불 요청
 */
import { useCallback } from "react";
import { View, Text, ScrollView, Alert, StyleSheet } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useOrder, useRefundOrder, useCancelOrder } from "@/hooks/useOrders";
import type { RefundResponse } from "@/config/api";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { formatKRW } from "@/lib/format";
import i18n from "@/i18n";
import { ORDER_STATUS } from "@/constants/status";

function InfoRow({ label, value, colors }: { label: string; value: string; colors: Record<string, string> }) {
  return (
    <View style={styles.infoRow}>
      <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[typography.body, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
}

export default function OrderDetailScreen() {
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const orderId = typeof params.id === "string" ? params.id : params.id?.[0] ?? "";

  const { data: order, isLoading, isError, refetch } = useOrder(orderId);
  const refundMutation = useRefundOrder();
  const cancelMutation = useCancelOrder();

  const canRefund =
    order?.status === ORDER_STATUS.CONFIRMED ||
    order?.status === ORDER_STATUS.PAID ||
    order?.status === ORDER_STATUS.PARTIALLY_REFUNDED;
  const canCancel = order?.status === ORDER_STATUS.PAYMENT_REQUIRED;

  const handleRefund = useCallback(() => {
    // 환불 확인 다이얼로그에 환불 예정 금액 표시 — 사용자가 얼마를 돌려받는지 확인 가능(P2-C13)
    const refundAmountText = order ? formatKRW(order.total_amount) : "";
    const confirmMsg = refundAmountText
      ? t("order.refundConfirmWithAmount", { amount: refundAmountText })
      : t("order.refundConfirm");
    Alert.alert(t("order.refund"), confirmMsg, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.confirm"),
        style: "destructive",
        onPress: () => {
          refundMutation.mutate(
            { orderId, reason: t("order.userRequest") },
            {
              onSuccess: (data: RefundResponse) => {
                // requires_approval=true: 수동 승인 필요, false: 즉시 처리 — 다른 안내 메시지(P2-C5)
                // 실제 환불 금액을 메시지에 포함 — 부분 환불 시 원금과 다를 수 있음(P2-C13)
                const refundedAmount = formatKRW(data.refund_amount);
                const msg = data.requires_approval
                  ? t("order.status.approvalRefundWithAmount", { amount: refundedAmount })
                  : t("order.status.immediateRefundWithAmount", { amount: refundedAmount });
                Alert.alert(t("common.confirm"), msg);
              },
              onError: (error: unknown) => {
                Alert.alert(t("common.error"), error instanceof Error ? error.message : t("common.error"));
              },
            },
          );
        },
      },
    ]);
  }, [orderId, order, refundMutation, t]);

  const handleCancel = useCallback(() => {
    cancelMutation.mutate(orderId, {
      onSuccess: () => refetch(),
      onError: (error: unknown) => Alert.alert(t("common.error"), error instanceof Error ? error.message : t("common.error")),
    });
  }, [orderId, cancelMutation, refetch, t]);

  if (isError) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("order.detail") }} />
        <EmptyState
          title={t("common.error")}
          message={t("common.serverError")}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      </SafeAreaView>
    );
  }

  if (isLoading || !order) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "" }} />
        <View style={styles.body}>
          <Skeleton width="60%" height={24} />
          <Skeleton width="100%" height={120} borderRadius={16} style={{ marginTop: spacing.lg }} />
        </View>
      </SafeAreaView>
    );
  }

  const statusLabel = (() => {
    const map: Record<string, string> = {
      [ORDER_STATUS.CONFIRMED]: t("order.status.confirmed"),
      [ORDER_STATUS.PAID]: t("order.status.confirmed"),
      [ORDER_STATUS.REFUNDED]: t("order.status.refunded"),
      [ORDER_STATUS.CANCELLED]: t("order.status.cancelled"),
      [ORDER_STATUS.PAYMENT_REQUIRED]: t("order.paymentPending"),
      [ORDER_STATUS.PARTIALLY_REFUNDED]: t("order.status.partiallyRefunded"),
      [ORDER_STATUS.AUTHORIZED]: t("order.status.authorized"),
      [ORDER_STATUS.PENDING]: t("order.status.pending"),
      [ORDER_STATUS.EXPIRED]: t("order.status.expired"),
    };
    return map[order.status] ?? order.status;
  })();

  return (
    <SafeAreaView testID="order.detail.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("order.detail") }} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* 상태 뱃지 */}
        <Animated.View entering={FadeIn.springify()} style={styles.statusRow}>
          <Badge label={statusLabel} variant={canRefund ? "default" : "outline"} />
          <Text style={[typography.micro, { color: colors.mutedForeground }]}>
            {new Date(order.created_at).toLocaleString(i18n.language?.startsWith("ko") ? "ko-KR" : "en-US")}
          </Text>
        </Animated.View>

        {/* 결제 정보 카드 */}
        <Animated.View entering={FadeInDown.springify()} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
          <InfoRow label={t("booking.quantity")} value={t("order.tickets", { count: order.quantity })} colors={colors} />
          <InfoRow label={t("order.unitPrice")} value={formatKRW(order.unit_price)} colors={colors} />
          <View style={[styles.totalRow, { borderColor: colors.border }]}>
            <Text style={[typography.body, { color: colors.mutedForeground }]}>
              {t("booking.total")}
            </Text>
            <Text style={[typography.h2, { color: colors.primary }]}>
              {formatKRW(order.total_amount)}
            </Text>
          </View>
        </Animated.View>

        {/* 결제 상세 */}
        <Animated.View entering={FadeInDown.springify().delay(80)} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
          <InfoRow label={t("order.orderId")} value={order.id.slice(0, 12) + "..."} colors={colors} />
          <InfoRow label={t("order.orderType")} value={order.order_type} colors={colors} />
          <InfoRow label={t("order.currency")} value={order.payment_currency} colors={colors} />
          {order.pg_provider && (
            <InfoRow label={t("order.pgProvider")} value={order.pg_provider} colors={colors} />
          )}
          {order.pg_approved_at && (
            <InfoRow label={t("order.approvedAt")} value={new Date(order.pg_approved_at).toLocaleString(i18n.language?.startsWith("ko") ? "ko-KR" : "en-US")} colors={colors} />
          )}
          {order.payment_failed_reason && (
            <InfoRow label={t("order.failReason")} value={order.payment_failed_reason} colors={colors} />
          )}
        </Animated.View>

        {/* 액션 버튼 */}
        {canRefund && (
          <Button
            testID="order.detail.refund"
            title={refundMutation.isPending ? t("booking.processing") : t("order.refund")}
            onPress={handleRefund}
            variant="outline"
            size="lg"
            disabled={refundMutation.isPending}
            style={{ marginTop: spacing.lg }}
          />
        )}
        {canCancel && (
          <Button
            title={cancelMutation.isPending ? t("booking.processing") : t("order.status.cancelled")}
            onPress={handleCancel}
            variant="outline"
            size="lg"
            disabled={cancelMutation.isPending}
            style={{ marginTop: spacing.lg }}
          />
        )}

        <View style={{ height: spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: {
    padding: spacing.xl,
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  card: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    marginBottom: spacing.lg,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
  },
});

/**
 * 티켓 상세 + TOTP QR 화면
 *
 * 화면 구성:
 *   1. 이벤트 요약 (제목, 날짜, 장소, 티어)
 *   2. QR 코드 영역 (TOTP, 자동 갱신)
 *   3. 티켓 상태 뱃지
 */
import { useEffect, useCallback, useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useTicket, useTicketQr } from "@/hooks/useTickets";
import { QRTicket } from "@/components/ticket/QRTicket";
import { cacheTicketQr, getCachedTicketQr } from "@/lib/offline-tickets";
import type { TicketQrResponse } from "@/config/api";
import { CountdownWidget } from "@/components/ticket/CountdownWidget";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { formatEventDate, formatKRW } from "@/lib/format";
import { trackScreenView } from "@/lib/analytics";
import { shareTicket } from "@/lib/sharing";
import * as haptics from "@/lib/haptics";
import { addTicketToWallet } from "@/lib/wallet-pass";
import { TICKET_STATUS } from "@/constants/status";
import { Alert } from "react-native";

export default function TicketDetailScreen() {
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const ticketId = typeof params.id === "string" ? params.id : params.id?.[0] ?? "";

  const { data: ticket, isLoading, isError, refetch } = useTicket(ticketId);
  const isActive = ticket?.status === TICKET_STATUS.ACTIVE;
  const { data: qrData } = useTicketQr(ticketId, isActive);

  // AUDIT 2026-04-20 §10 P0: 서버 QR 응답 수신 시 SecureStore에 캐시 — 오프라인 입장 지원
  useEffect(() => {
    if (qrData && ticketId) {
      void cacheTicketQr(ticketId, qrData);
    }
  }, [qrData, ticketId]);

  // 오프라인 폴백: 서버 응답이 없으면 캐시된 QR 로드
  const [cachedQr, setCachedQr] = useState<TicketQrResponse | null>(null);
  useEffect(() => {
    if (!ticketId || qrData) return;
    let cancelled = false;
    void (async () => {
      const cached = await getCachedTicketQr(ticketId);
      if (!cancelled) setCachedQr(cached);
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketId, qrData]);

  useEffect(() => {
    trackScreenView("ticket_detail");
    if (isActive) haptics.light();
  }, [isActive]);

  const handleAddToWallet = useCallback(async () => {
    if (!ticketId) return;
    haptics.light();
    const result = await addTicketToWallet(ticketId);
    if (result.status === "unsupported") {
      Alert.alert(t("wallet.title"), t("wallet.unsupported"));
    } else if (result.status === "error") {
      haptics.error();
      Alert.alert(t("common.error"), result.message);
    } else if (result.status === "added") {
      haptics.success();
    }
  }, [ticketId, t]);

  const handleShare = useCallback(() => {
    if (!ticket) return;
    shareTicket({
      eventId: ticket.event_id,
      title: ticket.event_title ?? "Event",
      date: ticket.event_date ? formatEventDate(ticket.event_date) : undefined,
    });
  }, [ticket]);

  if (isError) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("ticket.myTickets") }} />
        <EmptyState
          title={t("common.error")}
          message={t("common.serverError")}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      </SafeAreaView>
    );
  }

  if (isLoading || !ticket) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "" }} />
        <View style={styles.body}>
          <Skeleton width="70%" height={24} />
          <Skeleton width="50%" height={18} style={{ marginTop: spacing.md }} />
          <Skeleton width={200} height={200} borderRadius={12} style={{ marginTop: spacing.xl, alignSelf: "center" }} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView testID="ticket.detail.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: ticket.event_title ?? t("ticket.myTickets") }} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* 이벤트 정보 */}
        <Animated.View entering={FadeIn.springify()} style={[styles.eventCard, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
          <Text style={[typography.h3, { color: colors.foreground }]} numberOfLines={2}>
            {ticket.event_title ?? "Event"}
          </Text>

          {ticket.event_date && (
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
              {formatEventDate(ticket.event_date)}
            </Text>
          )}

          <View style={styles.metaRow}>
            {ticket.tier_name && (
              <Badge label={ticket.tier_name} variant="outline" />
            )}
            {ticket.seat_label && (
              <Text style={[typography.bodySmall, { color: colors.violet, marginLeft: spacing.sm }]}>
                {ticket.seat_label}
              </Text>
            )}
          </View>

          <View style={[styles.priceRow, { borderColor: colors.border }]}>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
              {t("booking.total")}
            </Text>
            <Text style={[typography.h4, { color: colors.primary }]}>
              {formatKRW(ticket.purchase_price)}
            </Text>
          </View>
        </Animated.View>

        {/* D-day 카운트다운 (Phase D.1) */}
        {ticket.status === TICKET_STATUS.ACTIVE && ticket.event_date && (
          <View style={{ marginTop: spacing.lg }}>
            <CountdownWidget eventDate={ticket.event_date} />
          </View>
        )}

        {/* QR 코드 — 온라인 시 서버 응답, 오프라인 시 캐시된 QR */}
        <QRTicket
          ticketId={ticketId}
          initialQr={qrData ?? cachedQr ?? null}
          ticketStatus={ticket.status}
        />

        {/* 티켓 상태 */}
        <View style={styles.statusRow}>
          <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
            {t("order.detail")}
          </Text>
          <View style={styles.statusBadges}>
            {ticket.event_category && (
              <Badge label={ticket.event_category} variant="outline" />
            )}
            <Badge
              label={t(`ticket.${ticket.status}`, { defaultValue: ticket.status.toUpperCase() })}
              variant={ticket.status === TICKET_STATUS.ACTIVE ? "default" : "outline"}
              style={{ marginLeft: spacing.sm }}
            />
          </View>
        </View>

        {/* Wallet 추가 + 공유 (Phase D.4) */}
        {ticket.status === TICKET_STATUS.ACTIVE && (
          <>
            <Button
              title={t("wallet.addToWallet")}
              variant="primary"
              onPress={handleAddToWallet}
              size="lg"
              style={{ marginTop: spacing.lg }}
            />
            <Button
              title={t("event.share")}
              variant="outline"
              onPress={handleShare}
              size="lg"
              style={{ marginTop: spacing.sm }}
            />
          </>
        )}

        {/* 하단 여백 */}
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
  eventCard: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
  },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: spacing.xl,
  },
  statusBadges: {
    flexDirection: "row",
    alignItems: "center",
  },
});

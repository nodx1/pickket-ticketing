/**
 * TOTP QR 티켓 컴포넌트
 * 5초마다 자동 갱신 + 카운트다운 링
 */
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import QRCode from "react-native-qrcode-svg";
import * as ScreenCapture from "expo-screen-capture";
import { useTranslation } from "react-i18next";
import { useNetInfo } from "@react-native-community/netinfo";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useRotatingQR } from "@/hooks/useRotatingQR";
import { getTicketQr, type TicketQrResponse } from "@/config/api";
import { cacheTicketQr } from "@/lib/offline-tickets";
import { TICKET_STATUS } from "@/constants/status";
import { useCallback, useEffect } from "react";

interface QRTicketProps {
  ticketId: string;
  initialQr: TicketQrResponse | null;
  ticketStatus: string;
}

export function QRTicket({ ticketId, initialQr, ticketStatus }: QRTicketProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const netInfo = useNetInfo();
  const isOffline = netInfo.isConnected === false;

  // QR 코드 표시 중 스크린 캡처/녹화 차단 (암표 방지)
  // DEV: __DEV__에서는 비활성화 (Maestro 스크린샷 테스트용)
  const isActiveTicket = ticketStatus === TICKET_STATUS.ACTIVE;
  useEffect(() => {
    if (!isActiveTicket || __DEV__) return;

    ScreenCapture.preventScreenCaptureAsync("qr-ticket");
    return () => {
      ScreenCapture.allowScreenCaptureAsync("qr-ticket");
    };
  }, [isActiveTicket]);

  // AUDIT 2026-04-20 §10 P0: 오프라인 시 네트워크 호출 스킵, 캐시된 initialQr만 렌더
  const fetchQr = useCallback(async (): Promise<TicketQrResponse | null> => {
    if (isOffline) return null;
    try {
      const fresh = await getTicketQr(ticketId);
      // 신선한 서버 QR은 로테이션마다 갱신되는 캐시로 저장
      void cacheTicketQr(ticketId, fresh);
      return fresh;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
      return null;
    }
  }, [ticketId, isOffline]);

  const { qrPayload, secondsRemaining, isTotp, loading, stale } = useRotatingQR(
    initialQr,
    fetchQr,
  );

  // 사용 완료 or 취소된 티켓
  if (ticketStatus === TICKET_STATUS.USED) {
    return (
      <View style={[styles.container, styles.completedContainer]}>
        <Text style={[typography.h1, { color: colors.success }]}>✓</Text>
        <Text style={[typography.h3, { color: colors.success, marginTop: spacing.sm }]}>
          {t("ticket.attended")}
        </Text>
      </View>
    );
  }

  if (ticketStatus === TICKET_STATUS.CANCELLED || ticketStatus === TICKET_STATUS.EXPIRED) {
    return (
      <View style={[styles.container, styles.completedContainer]}>
        <Text style={[typography.h3, { color: colors.destructive }]}>
          {t("ticket.cancelled")}
        </Text>
      </View>
    );
  }

  // TRANSFERRED/PENDING 상태: QR 없음 → 안내 메시지 (무한 스피너 방지 P2-C3)
  if (ticketStatus === TICKET_STATUS.TRANSFERRED) {
    return (
      <View style={[styles.container, styles.completedContainer]}>
        <Text style={[typography.h3, { color: colors.mutedForeground }]}>
          {t("ticket.transferred")}
        </Text>
      </View>
    );
  }

  if (ticketStatus === TICKET_STATUS.PENDING) {
    return (
      <View style={[styles.container, styles.completedContainer]}>
        <Text style={[typography.h3, { color: colors.mutedForeground }]}>
          {t("ticket.pending")}
        </Text>
      </View>
    );
  }

  if (loading || !qrPayload) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // 카운트다운 프로그레스 (0~1)
  const totalSeconds = initialQr?.expires_in_seconds ?? 15;
  const progress = secondsRemaining / totalSeconds;

  return (
    <View testID="ticket.qr" style={styles.container} accessibilityRole="summary" accessibilityLabel={t("ticket.qrAccessibilityLabel")}>
      {/* QR 코드 */}
      <View
        style={[styles.qrWrapper, { borderColor: colors.border, backgroundColor: colors.card }]}
        accessible
        accessibilityRole="image"
        accessibilityLabel={t("ticket.qrCodeLabel")}
      >
        <View style={styles.qrInner}>
          <QRCode
            value={qrPayload}
            size={200}
            backgroundColor="white"
            color="black"
          />
        </View>
      </View>

      {/* 회전 갱신 실패 경고 — 만료된 QR 이 입장에서 거부될 수 있음을 사용자에게 고지(P2-C19) */}
      {isTotp && stale && (
        <Text
          style={[typography.micro, { color: colors.warning, marginTop: spacing.sm }]}
          accessibilityRole="alert"
        >
          {t("ticket.qrRefreshFailed")}
        </Text>
      )}

      {/* 카운트다운 */}
      {isTotp && (
        <View style={styles.countdownRow}>
          <View style={[styles.progressBar, { backgroundColor: colors.muted }]}>
            <View
              style={[
                styles.progressFill,
                {
                  backgroundColor: progress > 0.3 ? colors.primary : colors.warning,
                  width: `${progress * 100}%`,
                },
              ]}
            />
          </View>
          <Text style={[typography.micro, { color: colors.mutedForeground, marginLeft: spacing.sm }]}>
            {t("ticket.secondsRemaining", { seconds: secondsRemaining })}
          </Text>
        </View>
      )}

      <Text style={[typography.micro, { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.sm }]}>
        {t("ticket.qrRefresh")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    paddingVertical: spacing.xl,
  },
  completedContainer: {
    justifyContent: "center",
    minHeight: 200,
  },
  loadingContainer: {
    justifyContent: "center",
    minHeight: 240,
  },
  qrWrapper: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  qrInner: {
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
  },
  countdownRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
    width: 200 + spacing.lg * 2,
  },
  progressBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
});

/**
 * 티켓 카드 컴포넌트
 * 목록에서 사용: 이벤트 정보 + 티어 + 상태 뱃지
 */
import { memo } from "react";
import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { Badge } from "@/components/ui/Badge";
import { formatEventDate, formatKRW } from "@/lib/format";
import type { Ticket } from "@/config/api";
import { TICKET_STATUS } from "@/constants/status";

interface TicketCardProps {
  ticket: Ticket;
}

function getStatusVariant(status: string): "default" | "destructive" | "outline" {
  switch (status) {
    case TICKET_STATUS.ACTIVE:
      return "default";
    case TICKET_STATUS.USED:
    case TICKET_STATUS.TRANSFERRED:
      return "outline";
    case TICKET_STATUS.CANCELLED:
    case TICKET_STATUS.EXPIRED:
      return "destructive";
    default:
      return "outline";
  }
}

function getStatusLabel(status: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    [TICKET_STATUS.ACTIVE]: t("ticket.active"),
    [TICKET_STATUS.USED]: t("ticket.used"),
    [TICKET_STATUS.TRANSFERRED]: t("ticket.transferred"),
    [TICKET_STATUS.CANCELLED]: t("ticket.cancelled"),
  };
  return map[status] ?? status;
}

export const TicketCard = memo(function TicketCard({ ticket }: TicketCardProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  return (
    <TouchableOpacity
      testID={`ticket.card.${ticket.id}`}
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={() => router.push(`/ticket/${ticket.id}`)}
      activeOpacity={0.7}
      accessibilityLabel={`${ticket.event_title ?? ""} ${ticket.tier_name ?? ""}`}
      accessibilityRole="button"
    >
      <View style={styles.header}>
        <Text style={[typography.h4, { color: colors.foreground, flex: 1 }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {ticket.event_title ?? t("common.event")}
        </Text>
        <Badge
          label={getStatusLabel(ticket.status, t)}
          variant={getStatusVariant(ticket.status)}
        />
      </View>

      <View style={styles.details}>
        {ticket.event_date && (
          <Text style={[typography.bodySmall, { color: colors.mutedForeground }]} maxFontSizeMultiplier={1.3}>
            {formatEventDate(ticket.event_date)}
          </Text>
        )}

        <View style={styles.metaRow}>
          {ticket.tier_name && (
            <Text style={[typography.micro, { color: colors.violet }]} maxFontSizeMultiplier={1.3}>
              {ticket.tier_name}
            </Text>
          )}
          {ticket.seat_label && (
            <Text style={[typography.micro, { color: colors.mutedForeground, marginLeft: spacing.sm }]} maxFontSizeMultiplier={1.3}>
              {ticket.seat_label}
            </Text>
          )}
          <Text style={[typography.micro, { color: colors.primary, marginLeft: "auto" }]} maxFontSizeMultiplier={1.3}>
            {formatKRW(ticket.purchase_price)}
          </Text>
        </View>
      </View>

      {ticket.event_category && (
        <View style={styles.footer}>
          <Badge label={ticket.event_category} variant="outline" />
        </View>
      )}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  details: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  footer: {
    marginTop: spacing.sm,
  },
});

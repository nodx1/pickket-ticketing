/**
 * Phase F.1 — 지갑 허브
 * 티켓 / 멤버십 / 포인트 통합 뷰
 */
import { View, Text, ScrollView, Pressable, StyleSheet, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useMyTickets } from "@/hooks/useTickets";
import { useMyFanclubs } from "@/hooks/useFanclubs";
import { usePointBalance } from "@/hooks/usePoints";
import { getTotalPoints } from "@/config/api";
import { Skeleton } from "@/components/ui/Skeleton";
import { TICKET_STATUS, MEMBERSHIP_STATUS } from "@/constants/status";

export default function WalletScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const { data: ticketsData, isLoading: loadingTickets } = useMyTickets(0, 20);
  const { data: memberships, isLoading: loadingFanclubs } = useMyFanclubs();
  const { data: pointBalance, isLoading: loadingPoints } = usePointBalance();

  const activeTickets = (ticketsData?.tickets ?? []).filter(
    (ticket) => ticket.status === TICKET_STATUS.ACTIVE,
  );
  const totalPoints = pointBalance ? getTotalPoints(pointBalance) : 0;

  return (
    <SafeAreaView testID="wallet.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("wallet.title") }} />

      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.xl }}>
        {/* 요약 카드 */}
        <View testID="wallet.summary" style={[styles.summary, { backgroundColor: colors.primary }]}>
          <Text style={[typography.bodySmall, { color: "#fff", opacity: 0.85 }]}>
            {t("wallet.overview")}
          </Text>
          <View style={styles.summaryRow}>
            <SummaryItem label={t("wallet.tickets")} value={String(activeTickets.length)} />
            <SummaryItem label={t("wallet.memberships")} value={String(memberships?.length ?? 0)} />
            <SummaryItem label={t("wallet.points")} value={totalPoints.toLocaleString()} />
          </View>
        </View>

        {/* 티켓 */}
        <Section
          title={t("wallet.tickets")}
          testID="wallet.section.tickets"
          moreTestID="wallet.more.tickets"
          onMore={() => router.push("/(tabs)/tickets" as never)}
        >
          {loadingTickets ? (
            <Skeleton width="100%" height={80} borderRadius={16} />
          ) : activeTickets.length === 0 ? (
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
              {t("wallet.ticketsEmpty")}
            </Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.md }}>
              {activeTickets.slice(0, 5).map((ticket) => (
                <Pressable
                  key={ticket.id}
                  onPress={() => router.push(`/ticket/${ticket.id}` as never)}
                  style={[styles.ticketCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <Text style={[typography.body, { color: colors.foreground, fontWeight: "700" }]} numberOfLines={2}>
                    {ticket.event_title}
                  </Text>
                  <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                    {ticket.tier_name ?? ""}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </Section>

        {/* 멤버십 */}
        <Section
          title={t("wallet.memberships")}
          testID="wallet.section.memberships"
          moreTestID="wallet.more.memberships"
          onMore={() => router.push("/wallet/memberships" as never)}
        >
          {loadingFanclubs ? (
            <Skeleton width="100%" height={60} borderRadius={16} />
          ) : !memberships || memberships.length === 0 ? (
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
              {t("wallet.membershipsEmpty")}
            </Text>
          ) : (
            <View style={{ gap: spacing.sm }}>
              {memberships.slice(0, 3).map((m) => (
                <View
                  key={m.id}
                  style={[styles.membershipRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  {m.logo_url ? (
                    <Image source={{ uri: m.logo_url }} style={styles.membershipLogo} />
                  ) : (
                    <View style={[styles.membershipLogo, { backgroundColor: colors.muted }]} />
                  )}
                  <View style={{ flex: 1, marginLeft: spacing.md }}>
                    <Text style={[typography.body, { color: colors.foreground, fontWeight: "600" }]}>
                      {m.fanclub_name}
                    </Text>
                    <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                      {m.artist_name} · {t(`memberships.tier.${m.tier || "basic"}`, { defaultValue: m.tier })}
                    </Text>
                  </View>
                  {m.status === MEMBERSHIP_STATUS.ACTIVE && (
                    <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                      <Text style={[typography.micro, { color: "#fff" }]}>{t("memberships.active")}</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}
        </Section>

        {/* 포인트 */}
        <Section
          title={t("wallet.points")}
          testID="wallet.section.points"
          moreTestID="wallet.more.points"
          onMore={() => router.push("/wallet/points" as never)}
        >
          {loadingPoints ? (
            <Skeleton width="100%" height={60} borderRadius={16} />
          ) : (
            <View style={[styles.pointsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>{t("points.fan")}</Text>
                <Text style={[typography.h3, { color: colors.foreground, marginTop: 2 }]}>
                  {(pointBalance?.fan ?? 0).toLocaleString()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>{t("points.social")}</Text>
                <Text style={[typography.h3, { color: colors.foreground, marginTop: 2 }]}>
                  {(pointBalance?.social ?? 0).toLocaleString()}
                </Text>
              </View>
            </View>
          )}
        </Section>

        {/* 쿠폰 placeholder (v2 팀 이관) */}
        <Section title={t("wallet.coupons")}>
          <View style={[styles.comingSoon, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, textAlign: "center" }]}>
              {t("wallet.couponsComingSoon")}
            </Text>
          </View>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={[typography.h2, { color: "#fff" }]}>{value}</Text>
      <Text style={[typography.bodySmall, { color: "#fff", opacity: 0.85 }]}>{label}</Text>
    </View>
  );
}

function Section({
  title,
  testID,
  moreTestID,
  onMore,
  children,
}: {
  title: string;
  testID?: string;
  moreTestID?: string;
  onMore?: () => void;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View testID={testID}>
      <View style={styles.sectionHeader}>
        <Text style={[typography.h4, { color: colors.foreground }]}>{title}</Text>
        {onMore && (
          <Pressable testID={moreTestID} onPress={onMore}>
            <Text style={[typography.bodySmall, { color: colors.primary }]}>{t("common.seeAll")}</Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  summary: {
    padding: spacing.xl,
    borderRadius: radius.lg,
    gap: spacing.md,
  },
  summaryRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  ticketCard: {
    width: 180,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  membershipRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  membershipLogo: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  pointsCard: {
    flexDirection: "row",
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.lg,
  },
  comingSoon: {
    padding: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});

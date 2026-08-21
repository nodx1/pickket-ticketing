/**
 * Me 탭 — 프로필 + 내 티켓 통합
 */
export { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  StyleSheet,
  Linking,
  ActivityIndicator,
  RefreshControl,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useAuthStore } from "@/hooks/useAuth";
import { useScrollDirection } from "@/stores/scrollDirection";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { getUserStats, type UserStats } from "@/config/api";
import { useQuery } from "@tanstack/react-query";
import { Avatar } from "@/components/ui/Avatar";
import { Divider } from "@/components/ui/Divider";
import { EmptyState } from "@/components/common/EmptyState";
import { FanLevelCard } from "@/components/fan/FanLevelCard";
import { useFanProfile } from "@/hooks/useFanProfile";
import { TicketCard } from "@/components/ticket/TicketCard";
import { useMyTickets, groupTicketsByDate } from "@/hooks/useTickets";
import { trackScreenView } from "@/lib/analytics";
import { useEffect } from "react";

function StatCard({ label, value, colors }: { label: string; value: string | number; colors: Record<string, string> }) {
  return (
    <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[typography.h3, { color: colors.primary }]}>{value}</Text>
      <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}>{label}</Text>
    </View>
  );
}

function MenuItem({
  label,
  onPress,
  colors,
  destructive,
  testID,
}: {
  label: string;
  onPress: () => void;
  colors: Record<string, string>;
  destructive?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      style={styles.menuItem}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <Text style={[typography.body, { color: destructive ? colors.destructive : colors.foreground }]}>{label}</Text>
      <Text style={[typography.body, { color: colors.mutedForeground }]}>›</Text>
    </TouchableOpacity>
  );
}

export default function MeScreen() {
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const router = useRouter();
  const { isGuest } = useRequireAuth();
  const user = useAuthStore((s) => s.user);
  const logoutAction = useAuthStore((s) => s.logout);
  const deleteAccountAction = useAuthStore((s) => s.deleteAccount);
  const setScrollY = useScrollDirection((s) => s.setScrollY);

  useEffect(() => {
    trackScreenView("me");
  }, []);

  const { data: stats } = useQuery<UserStats>({
    queryKey: ["user", "stats"],
    queryFn: getUserStats,
    enabled: !isGuest,
  });

  const { data: fanProfile, isLoading: fanLoading } = useFanProfile();
  const { data: ticketData, isLoading: ticketsLoading, refetch: refetchTickets, isRefetching } = useMyTickets();

  const tickets = ticketData?.tickets ?? [];
  const { upcoming } = groupTicketsByDate(tickets);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setScrollY(e.nativeEvent.contentOffset.y);
    },
    [setScrollY],
  );

  const handleLogout = useCallback(() => {
    Alert.alert(t("auth.logout"), "", [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.confirm"),
        onPress: async () => {
          await logoutAction();
          router.replace("/(tabs)");
        },
      },
    ]);
  }, [logoutAction, router, t]);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(t("profile.deleteAccount"), t("profile.deleteAccountConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.confirm"),
        style: "destructive",
        onPress: async () => {
          try {
            await deleteAccountAction();
            router.replace("/(tabs)");
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : t("common.serverError");
            Alert.alert(t("common.error"), msg);
          }
        },
      },
    ]);
  }, [deleteAccountAction, router, t]);

  if (isGuest) {
    return (
      <SafeAreaView testID="me.guest" style={[styles.container, { backgroundColor: colors.background }]}>
        <EmptyState
          icon="person-circle-outline"
          title={t("auth.loginRequired")}
          message={t("auth.loginToContinue")}
          actionLabel={t("auth.login.submit")}
          onAction={() => router.push("/(auth)/login")}
          actionTestID="me.guest.loginButton"
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView testID="me.screen" style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetchTickets} tintColor={colors.primary} />
        }
      >
        {/* 프로필 헤더 */}
        <Animated.View entering={FadeIn.springify()} style={styles.header}>
          <Avatar name={user?.name ?? ""} uri={user?.avatar_url} size={64} />
          <View style={styles.headerInfo}>
            <Text style={[typography.h2, { color: colors.foreground }]}>{user?.name}</Text>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>{user?.email}</Text>
          </View>
        </Animated.View>

        {/* 팬 레벨 카드 */}
        {fanLoading && (
          <View style={[styles.fanSkeleton, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          </View>
        )}
        {fanProfile && <FanLevelCard profile={fanProfile} />}

        {/* 통계 카드 */}
        {stats && (
          <Animated.View entering={FadeInDown.springify()} style={styles.statsRow}>
            <StatCard label={t("profile.totalBids")} value={stats.total_bids} colors={colors} />
            <StatCard label={t("profile.totalWins")} value={stats.total_wins} colors={colors} />
            <StatCard
              label={t("profile.winRate")}
              value={`${(stats.win_rate * 100).toFixed(0)}%`}
              colors={colors}
            />
          </Animated.View>
        )}

        {/* 내 티켓 (예정 3개) */}
        <Animated.View entering={FadeInDown.springify().delay(60)} style={styles.ticketSection}>
          <View style={styles.ticketHeader}>
            <Text style={[typography.h3, { color: colors.foreground }]}>
              {t("me.myTickets")}
            </Text>
            {upcoming.length > 0 && (
              <TouchableOpacity onPress={() => router.push("/tickets")}>
                <Text style={[typography.bodySmall, { color: colors.primary }]}>
                  {t("home.seeAll")} →
                </Text>
              </TouchableOpacity>
            )}
          </View>
          {ticketsLoading ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} style={{ marginTop: spacing.md }} />
          ) : upcoming.length === 0 ? (
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.sm }]}>
              {t("ticket.empty")}
            </Text>
          ) : (
            upcoming.slice(0, 3).map((ticket) => (
              <View key={ticket.id} style={styles.ticketCard}>
                <TicketCard ticket={ticket} />
              </View>
            ))
          )}
        </Animated.View>

        {/* 메뉴 */}
        <Animated.View entering={FadeInDown.springify().delay(120)} style={[styles.menuSection, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
          <MenuItem testID="me.menu.wallet" label={t("wallet.title")} onPress={() => router.push("/wallet")} colors={colors} />
          <Divider />
          <MenuItem testID="me.menu.orders" label={t("profile.orders")} onPress={() => router.push("/orders")} colors={colors} />
          <Divider />
          <MenuItem testID="me.menu.favorites" label={t("profile.favorites")} onPress={() => router.push("/favorites")} colors={colors} />
          <Divider />
          <MenuItem testID="me.menu.picks" label={t("picks.collection")} onPress={() => router.push("/fan-stamp/collection")} colors={colors} />
          <Divider />
          <MenuItem testID="me.menu.friends" label={t("friends.title")} onPress={() => router.push("/profile/friends")} colors={colors} />
          <Divider />
          <MenuItem testID="me.menu.memories" label={t("memories.title")} onPress={() => router.push("/profile/memories")} colors={colors} />
        </Animated.View>

        <Animated.View entering={FadeInDown.springify().delay(180)} style={[styles.menuSection, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
          <MenuItem testID="me.menu.edit" label={t("profile.editProfile")} onPress={() => router.push("/settings")} colors={colors} />
          <Divider />
          <MenuItem testID="me.menu.language" label={t("profile.language")} onPress={() => router.push("/settings/language")} colors={colors} />
          <Divider />
          <MenuItem testID="me.menu.notifications" label={t("profile.notifications")} onPress={() => router.push("/settings/push-preferences")} colors={colors} />
        </Animated.View>

        <Animated.View entering={FadeInDown.springify().delay(240)} style={[styles.menuSection, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
          <MenuItem label={t("profile.support")} onPress={() => Linking.openURL("mailto:support@pickket.kr")} colors={colors} />
          <Divider />
          <MenuItem label={t("profile.privacy")} onPress={() => router.push("/legal/privacy")} colors={colors} />
          <Divider />
          <MenuItem label={t("profile.terms")} onPress={() => router.push("/legal/terms")} colors={colors} />
          <Divider />
          <MenuItem label={t("profile.refundPolicy")} onPress={() => router.push("/legal/refund-policy")} colors={colors} />
        </Animated.View>

        <Animated.View entering={FadeInDown.springify().delay(300)} style={[styles.menuSection, { backgroundColor: colors.card, borderColor: colors.border, shadowColor: isDark ? "transparent" : "#000" }]}>
          <MenuItem label={t("auth.logout")} onPress={handleLogout} colors={colors} />
          <Divider />
          <MenuItem label={t("profile.deleteAccount")} onPress={handleDeleteAccount} colors={colors} destructive />
        </Animated.View>

        {/* 앱 버전 */}
        <Text style={[typography.micro, { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.lg }]}>
          {t("profile.version")} 0.1.0
        </Text>

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
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  headerInfo: {
    flex: 1,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xxl,
  },
  statCard: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  fanSkeleton: {
    height: 120,
    borderRadius: 20,
    borderWidth: 1,
    marginTop: spacing.lg,
    justifyContent: "center",
    alignItems: "center",
  },
  ticketSection: {
    marginTop: spacing.xxl,
  },
  ticketHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  ticketCard: {
    marginTop: spacing.sm,
  },
  menuSection: {
    borderRadius: radius.xl,
    borderWidth: 1,
    marginTop: spacing.lg,
    overflow: "hidden",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  menuItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});

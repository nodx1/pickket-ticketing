/**
 * 내 티켓 목록 화면
 * SectionList: "예정 이벤트" / "지난 이벤트"
 */
export { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { useCallback } from "react";
import { View, Text, SectionList, RefreshControl, StyleSheet, type NativeSyntheticEvent, type NativeScrollEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useMyTickets, groupTicketsByDate } from "@/hooks/useTickets";
import { TicketCard } from "@/components/ticket/TicketCard";
import { EmptyState } from "@/components/common/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useScrollDirection } from "@/stores/scrollDirection";
import type { Ticket } from "@/config/api";

interface TicketSection {
  title: string;
  data: Ticket[];
}

export default function TicketsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const { isGuest } = useRequireAuth();

  const setScrollY = useScrollDirection((s) => s.setScrollY);

  const { data, isLoading, isError, refetch, isRefetching } = useMyTickets();
  const tickets = data?.tickets ?? [];
  const { upcoming, past } = groupTicketsByDate(tickets);

  const sections: TicketSection[] = [];
  if (upcoming.length > 0) sections.push({ title: t("ticket.upcoming"), data: upcoming });
  if (past.length > 0) sections.push({ title: t("ticket.past"), data: past });

  const renderItem = useCallback(({ item }: { item: Ticket }) => (
    <View style={styles.cardWrapper}>
      <TicketCard ticket={item} />
    </View>
  ), []);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setScrollY(e.nativeEvent.contentOffset.y);
    },
    [setScrollY],
  );

  const renderSectionHeader = useCallback(({ section }: { section: TicketSection }) => (
    <Text style={[typography.h3, { color: colors.foreground, paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.sm }]}>
      {section.title}
    </Text>
  ), [colors.foreground]);

  if (isGuest) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <EmptyState
          icon="ticket-outline"
          title={t("auth.loginRequired")}
          message={t("auth.loginToContinue")}
          actionLabel={t("auth.login.submit")}
          onAction={() => router.push("/(auth)/login")}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <Text style={[typography.h2, { color: colors.foreground, padding: spacing.xl, paddingBottom: 0 }]}>
        {t("ticket.myTickets")}
      </Text>

      {isLoading ? (
        <View style={styles.skeletonList}>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} width="100%" height={100} borderRadius={16} style={{ marginBottom: spacing.md }} />
          ))}
        </View>
      ) : isError ? (
        <EmptyState
          title={t("common.error")}
          message={t("common.serverError")}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      ) : sections.length === 0 ? (
        <EmptyState
          icon="calendar-outline"
          title={t("ticket.empty")}
          actionLabel={t("ticket.explore")}
          onAction={() => router.push("/(tabs)/index")}
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
          stickySectionHeadersEnabled={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  skeletonList: {
    padding: spacing.xl,
  },
  listContent: {
    paddingBottom: spacing.xxl,
  },
  cardWrapper: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
});

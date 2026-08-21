/**
 * 공연 후 추억 모음 — My Memories (Phase D.3)
 *
 * 본 공연(past tickets)을 카드 그리드로 자동 정렬.
 * 탭하면 해당 티켓 상세로 이동 → QR / 후기 작성 진입.
 * 연말 회고 섹션: 올해 본 공연 수 + 가장 많이 본 카테고리.
 */
import { useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useMyTickets, groupTicketsByDate } from "@/hooks/useTickets";
import { EmptyState } from "@/components/common/EmptyState";
import { formatShortDate, getCategoryFallbackImage, getCategoryEmoji } from "@/lib/format";
import { summarizeByYear } from "@/lib/memories";

export default function MemoriesScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const { data, isLoading, isError } = useMyTickets(0, 200);

  const { past, summaries } = useMemo(() => {
    const list = data?.tickets ?? [];
    const { past } = groupTicketsByDate(list);
    // 최신순
    past.sort((a, b) => {
      const aa = a.event_date ? new Date(a.event_date).getTime() : 0;
      const bb = b.event_date ? new Date(b.event_date).getTime() : 0;
      return bb - aa;
    });
    return { past, summaries: summarizeByYear(past) };
  }, [data]);

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("memories.title") }} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (isError) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("memories.title") }} />
        <EmptyState title={t("common.error")} message={t("common.serverError")} />
      </SafeAreaView>
    );
  }

  if (past.length === 0) {
    return (
      <SafeAreaView testID="memories.screen.empty" style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("memories.title") }} />
        <EmptyState title={t("memories.empty")} message={t("memories.emptyDescription")} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView testID="memories.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={["bottom"]}>
      <Stack.Screen options={{ title: t("memories.title") }} />
      <ScrollView contentContainerStyle={styles.content}>
        {/* 연말 회고 */}
        {summaries.map((s) => (
          <View
            key={s.year}
            style={[styles.wrappedCard, { backgroundColor: colors.card, borderColor: colors.primary }]}
          >
            <Text style={[typography.micro, { color: colors.mutedForeground }]}>
              {t("memories.wrappedYear", { year: s.year })}
            </Text>
            <Text style={[typography.h1, { color: colors.primary, marginTop: spacing.xs }]}>
              {t("memories.wrappedCount", { count: s.count })}
            </Text>
            {s.topCategory && (
              <Text style={[typography.bodySmall, { color: colors.foreground, marginTop: spacing.xs }]}>
                {t("memories.wrappedCategory", {
                  emoji: getCategoryEmoji(s.topCategory),
                  category: s.topCategory,
                  count: s.topCategoryCount,
                })}
              </Text>
            )}
          </View>
        ))}

        {/* 카드 그리드 */}
        <View style={styles.grid}>
          {past.map((ticket) => (
            <TouchableOpacity
              key={ticket.id}
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(`/ticket/${ticket.id}`)}
              activeOpacity={0.85}
            >
              <Image
                source={{
                  uri: getCategoryFallbackImage(
                    ticket.event_category ?? null,
                    ticket.event_id ?? ticket.id,
                  ),
                }}
                style={styles.cardImage}
                contentFit="cover"
                transition={200}
                cachePolicy="memory-disk"
              />
              <View style={styles.cardInfo}>
                <Text
                  style={[typography.bodySmall, { color: colors.foreground }]}
                  numberOfLines={2}
                >
                  {ticket.event_title ?? "-"}
                </Text>
                {ticket.event_date && (
                  <Text
                    style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}
                  >
                    {formatShortDate(ticket.event_date)}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const CARD_GAP = spacing.md;

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  wrappedCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderLeftWidth: 4,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: CARD_GAP,
  },
  card: {
    width: "47%",
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: "hidden",
  },
  cardImage: {
    width: "100%",
    aspectRatio: 3 / 4,
    alignItems: "center",
    justifyContent: "center",
  },
  cardInfo: {
    padding: spacing.sm,
  },
});


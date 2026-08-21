/**
 * 추첨 진행 중 섹션 — 활성 추첨 이벤트 + D-day 카운트다운
 */
import { useCallback } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { resolveEventImage } from "@/lib/format";
import type { Event } from "@/config/api";

function getDDay(dateStr: string): string {
  const diff = Math.ceil(
    (new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
  if (diff <= 0) return "D-DAY";
  return `D-${diff}`;
}

interface LotterySectionProps {
  events: Event[];
}

const keyExtractor = (item: Event) => item.id;

export function LotterySection({ events }: LotterySectionProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const renderItem = useCallback(({ item }: { item: Event }) => {
    const dday = item.event_date ? getDDay(item.event_date) : "";
    const isUrgent = dday === "D-DAY" || dday === "D-1" || dday === "D-2";
    return (
      <TouchableOpacity
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={() => router.push(`/event/${item.id}`)}
        activeOpacity={0.7}
        accessibilityLabel={`${item.title} ${dday}`}
      >
        <Image
          source={{ uri: resolveEventImage(item) }}
          style={styles.cardImage}
          contentFit="cover"
          transition={200}
        />
        {/* D-day 뱃지 */}
        <View
          style={[
            styles.ddayBadge,
            { backgroundColor: isUrgent ? colors.hot : colors.primary },
          ]}
        >
          <Text style={styles.ddayText}>{dday}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text
            style={[typography.h5, { color: colors.foreground }]}
            numberOfLines={2}
          >
            {item.title}
          </Text>
          <Text
            style={[typography.micro, { color: colors.mutedForeground, marginTop: 2 }]}
            numberOfLines={1}
          >
            {item.venue}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }, [colors.card, colors.border, colors.hot, colors.primary, colors.foreground, colors.mutedForeground, router]);

  if (events.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="dice" size={18} color={colors.hot} />
          <Text style={[typography.h3, { color: colors.foreground, marginLeft: spacing.sm }]}>
            {t("home.section.lotteryActive")}
          </Text>
        </View>
        <View style={[styles.liveBadge, { backgroundColor: `${colors.hot}20` }]}>
          <View style={[styles.liveDot, { backgroundColor: colors.hot }]} />
          <Text style={[styles.liveText, { color: colors.hot }]}>LIVE</Text>
        </View>
      </View>

      <FlatList
        horizontal
        data={events}
        keyExtractor={keyExtractor}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={renderItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.xxl,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.md,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    gap: 4,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  liveText: {
    fontSize: 10,
    fontFamily: "Pretendard-Bold",
    fontWeight: "700",
  },
  list: {
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  card: {
    width: 160,
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: "hidden",
  },
  cardImage: {
    width: "100%",
    height: 100,
  },
  ddayBadge: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  ddayText: {
    fontSize: 11,
    fontFamily: "Pretendard-Bold",
    fontWeight: "700",
    color: "#FFFFFF",
  },
  cardBody: {
    padding: spacing.md,
  },
});

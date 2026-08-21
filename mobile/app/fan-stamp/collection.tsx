/**
 * 내 픽 컬렉션 — 2컬럼 그리드 + 정렬 + 빈 상태
 * Me 탭 "내 픽 컬렉션" 또는 PicksRing "전체보기"에서 진입
 */
import { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useRouter } from "expo-router";
import { Image } from "expo-image";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { usePicks } from "@/hooks/usePicks";
import { EmptyState } from "@/components/common/EmptyState";
import type { FanStamp } from "@/types/fan-stamp";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const GRID_GAP = spacing.sm;
const GRID_PADDING = spacing.lg;
const ITEM_SIZE = (SCREEN_WIDTH - GRID_PADDING * 2 - GRID_GAP) / 2;

type SortMode = "latest" | "event";

export default function PickCollectionScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const { data: picks, isLoading, refetch, isRefetching } = usePicks();
  const [sortMode, setSortMode] = useState<SortMode>("latest");

  const sortedPicks = useMemo(() => {
    const list = picks ?? [];
    if (sortMode === "event") {
      return [...list].sort((a, b) => a.eventId.localeCompare(b.eventId));
    }
    // latest — createdAt 내림차순
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [picks, sortMode]);

  const handlePress = useCallback(
    (pick: FanStamp) => {
      router.push(`/fan-stamp/${pick.eventId}`);
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: FanStamp; index: number }) => (
      <Animated.View entering={FadeInDown.delay(index * 40).springify()}>
        <TouchableOpacity
          style={[styles.gridItem, { backgroundColor: colors.card }]}
          onPress={() => handlePress(item)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={item.eventId}
        >
          <Image
            source={{ uri: item.imageUri }}
            style={styles.gridImage}
            contentFit="cover"
          />
          {/* 오버레이 정보 */}
          <View style={styles.overlay}>
            {item.status === "going" && (
              <View style={styles.goingBadge}>
                <Text style={styles.goingText}>{t("picks.going")}</Text>
              </View>
            )}
            {item.sequence_number != null && (
              <Text style={styles.seqNumber}>
                #{item.sequence_number}
              </Text>
            )}
          </View>
          <View style={styles.gridInfo}>
            <Text style={[styles.gridLabel, { color: colors.foreground }]} numberOfLines={1}>
              {item.eventId}
            </Text>
          </View>
        </TouchableOpacity>
      </Animated.View>
    ),
    [colors, handlePress, t],
  );

  const keyExtractor = useCallback((item: FanStamp) => item.id, []);

  const ListHeader = useMemo(
    () => (
      <View style={styles.headerRow}>
        <Text style={[typography.h3, { color: colors.foreground }]}>
          {t("picks.collection")}
        </Text>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
          {t("picks.total", { count: sortedPicks.length })}
        </Text>
      </View>
    ),
    [colors, t, sortedPicks.length],
  );

  const SortChips = useMemo(
    () => (
      <View style={styles.sortRow}>
        {(["latest", "event"] as SortMode[]).map((mode) => {
          const isActive = sortMode === mode;
          const label = mode === "latest" ? t("common.latest") : t("common.byEvent");
          return (
            <TouchableOpacity
              key={mode}
              style={[
                styles.sortChip,
                isActive
                  ? { backgroundColor: colors.primary }
                  : { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
              ]}
              onPress={() => setSortMode(mode)}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
            >
              <Text
                style={[
                  styles.sortChipText,
                  { color: isActive ? colors.primaryForeground : colors.mutedForeground },
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    ),
    [sortMode, colors, t],
  );

  if (!isLoading && sortedPicks.length === 0) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
        <Stack.Screen
          options={{
            title: t("picks.collection"),
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
          }}
        />
        <EmptyState
          icon="images-outline"
          title={t("picks.empty")}
          message={t("picks.emptyDesc")}
          actionLabel={t("picks.makePick")}
          onAction={() => router.push("/fan-stamp/new")}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <Stack.Screen
        options={{
          title: t("picks.collection"),
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.foreground,
        }}
      />
      <FlatList
        data={sortedPicks}
        numColumns={2}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        columnWrapperStyle={styles.columnWrapper}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            {ListHeader}
            {SortChips}
          </>
        }
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={colors.primary} />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: {
    padding: GRID_PADDING,
    paddingBottom: 80,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  sortRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  sortChip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  sortChipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  columnWrapper: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP,
  },
  gridItem: {
    width: ITEM_SIZE,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  gridImage: {
    width: ITEM_SIZE,
    height: ITEM_SIZE,
  },
  overlay: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  goingBadge: {
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  goingText: {
    color: "#FFF",
    fontSize: 10,
    fontWeight: "700",
  },
  seqNumber: {
    color: "#FFF",
    fontSize: 11,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  gridInfo: {
    padding: spacing.sm,
  },
  gridLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
});

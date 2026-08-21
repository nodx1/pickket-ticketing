/**
 * 즐겨찾기 목록 화면
 */
import { useCallback } from "react";
import { FlatList, RefreshControl, StyleSheet } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { spacing } from "@/config/theme";
import { useMyFavorites } from "@/hooks/useFavorites";
import { EventCard } from "@/components/event/EventCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import type { Event } from "@/config/api";

export default function FavoritesScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const { data: favorites, isLoading, isError, refetch, isRefetching } = useMyFavorites();

  const renderItem = useCallback(
    ({ item, index }: { item: Event; index: number }) => (
      <Animated.View entering={FadeInDown.springify().delay(index * 40)}>
        <EventCard event={item} variant="compact" />
      </Animated.View>
    ),
    [],
  );

  return (
    <SafeAreaView testID="favorites.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("profile.favorites") }} />

      {isLoading ? (
        <FlatList
          data={[1, 2, 3]}
          keyExtractor={(i) => String(i)}
          renderItem={() => (
            <Skeleton width="100%" height={100} borderRadius={16} style={{ marginBottom: spacing.md }} />
          )}
          contentContainerStyle={styles.listContent}
        />
      ) : isError ? (
        <EmptyState
          title={t("common.error")}
          message={t("common.serverError")}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      ) : !favorites || favorites.length === 0 ? (
        <EmptyState title={t("favorite.empty")} />
      ) : (
        <FlatList
          data={favorites}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: {
    padding: spacing.xl,
    gap: spacing.md,
  },
});

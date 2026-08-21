import { useCallback } from "react";
import { View, Text, FlatList, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { EventCard, EventCardSkeleton } from "@/components/event/EventCard";
import { Skeleton } from "@/components/ui/Skeleton";
import type { Event } from "@/config/api";

interface Props {
  events: Event[];
}

const keyExtractor = (item: Event) => item.id;

export function TrendingSection({ events }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const renderItem = useCallback(({ item }: { item: Event }) => (
    <View style={styles.cardWrapper}>
      <EventCard event={item} variant="compact" />
    </View>
  ), []);

  if (events.length === 0) return null;

  return (
    <View testID="home.trending.section" style={styles.container}>
      <Text style={[typography.h3, { color: colors.foreground, marginHorizontal: spacing.xl }]}>
        {t("home.trending")}
      </Text>
      <FlatList
        horizontal
        data={events}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        showsHorizontalScrollIndicator={false}
        removeClippedSubviews={true}
        initialNumToRender={4}
      />
    </View>
  );
}

export function TrendingSkeleton() {
  return (
    <View style={styles.container}>
      <Skeleton width={140} height={22} style={{ marginHorizontal: spacing.xl }} />
      <FlatList
        horizontal
        data={[1, 2, 3]}
        keyExtractor={(item) => String(item)}
        renderItem={() => (
          <View style={styles.cardWrapper}>
            <EventCardSkeleton variant="compact" />
          </View>
        )}
        contentContainerStyle={styles.list}
        showsHorizontalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.xxl,
  },
  list: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
  },
  cardWrapper: {
    marginRight: spacing.md,
  },
});

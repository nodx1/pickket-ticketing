import { useCallback } from "react";
import { View, Text, FlatList, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { EventCard, EventCardSkeleton } from "@/components/event/EventCard";
import { Skeleton } from "@/components/ui/Skeleton";
import type { RecommendedEvent } from "@/config/api";

interface Props {
  recommendations: RecommendedEvent[];
}

const keyExtractor = (item: RecommendedEvent) => item.id;

export function RecommendationSection({ recommendations }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const renderItem = useCallback(({ item }: { item: RecommendedEvent }) => (
    <View style={styles.cardWrapper}>
      <EventCard
        event={{
          id: item.id,
          title: item.title,
          image_url: item.image_url ?? undefined,
          venue: item.venue ?? undefined,
          event_date: item.event_date,
          category: item.category ?? undefined,
          status: item.status,
          min_price: item.min_price ?? undefined,
          location_city: item.location_city ?? undefined,
        }}
        variant="compact"
      />
      {item.reason && (
        <Text
          style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs, maxWidth: 180 }]}
          numberOfLines={2}
        >
          {item.reason}
        </Text>
      )}
    </View>
  ), [colors.mutedForeground]);

  if (recommendations.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={[typography.h3, { color: colors.foreground, marginHorizontal: spacing.xl }]}>
        {t("home.forYou")}
      </Text>
      <FlatList
        horizontal
        data={recommendations}
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

export function RecommendationSkeleton() {
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

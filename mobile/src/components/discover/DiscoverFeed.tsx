/**
 * DiscoverFeed — 풀스크린 수직 페이징 리스트 (Phase A.3)
 *
 * A.3: 단일 페이지 (events prop) 렌더
 * A.4: useInfiniteQuery 통합 예정
 *
 * FlashList 적용 — 메모리 recycling + 초기 렌더 최적화
 */
import { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  type LayoutChangeEvent,
  type ViewToken,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography } from "@/config/theme";
import { trackDiscoverCardView } from "@/lib/analytics";
import { DiscoverCard } from "./DiscoverCard";
import type { Event } from "@/config/api";

interface Props {
  events: Event[];
  onEndReached?: () => void;
}

export function DiscoverFeed({ events, onEndReached }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [cardHeight, setCardHeight] = useState(0);
  const seenRef = useRef<Set<string>>(new Set());

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0) setCardHeight(h);
  }, []);

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      viewableItems.forEach((token) => {
        const event = token.item as Event | undefined;
        if (!event || !token.isViewable) return;
        if (seenRef.current.has(event.id)) return;
        seenRef.current.add(event.id);
        trackDiscoverCardView(event.id);
      });
    },
    [],
  );

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 60,
    minimumViewTime: 500,
  }).current;

  const renderItem = useCallback(
    ({ item }: { item: Event }) => <DiscoverCard event={item} height={cardHeight} />,
    [cardHeight],
  );

  const keyExtractor = useCallback((item: Event) => item.id, []);

  // FlashList uses estimatedItemSize instead of getItemLayout

  if (events.length === 0) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.background }]}>
        <Text style={[typography.body, { color: colors.mutedForeground }]}>
          {t("discover.empty")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.fill} onLayout={handleLayout}>
      {cardHeight > 0 && (
        <FlashList
          data={events}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={cardHeight}
          snapToAlignment="start"
          decelerationRate="fast"
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          onViewableItemsChanged={handleViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});

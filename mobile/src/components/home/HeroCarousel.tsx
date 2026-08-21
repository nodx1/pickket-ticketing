import { useRef, useEffect, useCallback, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  AppState,
  type AppStateStatus,
} from "react-native";
import PagerView from "react-native-pager-view";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { typography, spacing, radius } from "@/config/theme";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatShortDate, formatPriceRange, resolveEventImage } from "@/lib/format";
import type { Event } from "@/config/api";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const HERO_HEIGHT = 260;
const AUTO_SLIDE_INTERVAL = 5000;

interface Props {
  events: Event[];
}

export function HeroCarousel({ events }: Props) {
  ;
  const router = useRouter();
  const pagerRef = useRef<PagerView>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const startAutoSlide = useCallback(() => {
    clearInterval(timerRef.current);
    if (events.length <= 1) return;
    timerRef.current = setInterval(() => {
      setActiveIndex((prev) => {
        const next = (prev + 1) % events.length;
        pagerRef.current?.setPage(next);
        return next;
      });
    }, AUTO_SLIDE_INTERVAL);
  }, [events.length]);

  useEffect(() => {
    startAutoSlide();
    return () => clearInterval(timerRef.current);
  }, [startAutoSlide]);

  // AUDIT §7 P1: 백그라운드 진입 시 auto-slide 정지, 포그라운드 복귀 시 재개
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState === "active") {
        startAutoSlide();
      } else {
        clearInterval(timerRef.current);
      }
    });
    return () => subscription.remove();
  }, [startAutoSlide]);

  const handlePageSelected = useCallback(
    (e: { nativeEvent: { position: number } }) => {
      setActiveIndex(e.nativeEvent.position);
      // Reset timer on manual swipe
      clearInterval(timerRef.current);
      startAutoSlide();
    },
    [startAutoSlide],
  );

  if (events.length === 0) return null;

  return (
    <View style={styles.container}>
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={0}
        onPageSelected={handlePageSelected}
      >
        {events.map((event) => (
          <TouchableOpacity
            key={event.id}
            activeOpacity={0.9}
            onPress={() => router.push(`/event/${event.id}`)}
            style={styles.slide}
            accessibilityLabel={`${event.title} ${event.venue ?? ""}`}
            accessibilityRole="button"
          >
            <Image
              source={{ uri: resolveEventImage(event) }}
              style={styles.image}
              contentFit="cover"
              placeholder={{ blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4" }}
              transition={300}
              cachePolicy="memory-disk"
            />
            {/* Gradient overlay */}
            <View style={styles.gradient} />
            {/* Content overlay */}
            <View style={styles.overlay}>
              {event.category && <Badge label={event.category} variant="outline" />}
              <Text
                style={[typography.h2, { color: "#FFFFFF", marginTop: spacing.sm }]}
                numberOfLines={2}
              >
                {event.title}
              </Text>
              <View style={styles.metaRow}>
                {event.event_date && (
                  <Text style={[typography.bodySmall, { color: "rgba(255,255,255,0.8)" }]}>
                    {formatShortDate(event.event_date)}
                  </Text>
                )}
                {event.venue && (
                  <Text style={[typography.bodySmall, { color: "rgba(255,255,255,0.8)", marginLeft: spacing.md }]}>
                    {event.venue}
                  </Text>
                )}
              </View>
              <Text style={[typography.h4, { color: "#FFFFFF", marginTop: spacing.xs }]}>
                {formatPriceRange(event.min_price, event.max_price)}
              </Text>
            </View>
          </TouchableOpacity>
        ))}
      </PagerView>

      {/* Page indicators */}
      {events.length > 1 && (
        <View style={styles.indicators}>
          {events.map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                {
                  backgroundColor: i === activeIndex ? "#FFFFFF" : "rgba(255,255,255,0.4)",
                  width: i === activeIndex ? 20 : 6,
                },
              ]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

export function HeroCarouselSkeleton() {
  return (
    <View style={styles.container}>
      <Skeleton width={SCREEN_WIDTH} height={HERO_HEIGHT} borderRadius={0} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: HERO_HEIGHT,
  },
  pager: {
    flex: 1,
  },
  slide: {
    flex: 1,
  },
  image: {
    ...StyleSheet.absoluteFillObject,
  },
  gradient: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    padding: spacing.xl,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.xs,
  },
  indicators: {
    position: "absolute",
    bottom: spacing.md,
    right: spacing.xl,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  dot: {
    height: 6,
    borderRadius: radius.full,
  },
});

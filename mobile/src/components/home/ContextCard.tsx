/**
 * 컨텍스트 카드 — DICE 메인 카드 정확 재현
 *
 * 풀블리드 이미지 + "FEATURED" / 컨텍스트 태그
 * 하단: 타이틀 + 날짜·장소 + 가격
 * 액션: 즐겨찾기(heart) · 공유 — 상세 페이지와 통일
 * 좌우 화살표 (캐러셀 시)
 */
import { useRef, useState, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import PagerView from "react-native-pager-view";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { formatShortDate, formatPriceRange, formatEventDate, resolveEventImage } from "@/lib/format";
import { selectionFeedback } from "@/lib/haptics";
import { shareEvent } from "@/lib/sharing";
import { useToggleFavorite } from "@/hooks/useEvents";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import type { Event } from "@/config/api";

type IoniconsName = React.ComponentProps<typeof Ionicons>["name"];

const CARD_HEIGHT = 320;

interface ContextCardProps {
  events: Event[];
  contextIcon?: IoniconsName;
  contextLabel?: string;
  contextColor?: string;
}

function CardSlide({
  event,
  contextIcon,
  contextLabel,
  contextColor,
}: {
  event: Event;
  contextIcon?: IoniconsName;
  contextLabel?: string;
  contextColor?: string;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { requireAuth } = useRequireAuth();
  const favoriteMutation = useToggleFavorite();
  const accentColor = contextColor ?? colors.primary;

  const handleFavorite = useCallback(() => {
    if (!requireAuth()) return;
    selectionFeedback();
    favoriteMutation.mutate(event.id);
  }, [event.id, requireAuth, favoriteMutation]);

  const handleShare = useCallback(() => {
    shareEvent({
      eventId: event.id,
      title: event.title,
      date: event.event_date ? formatEventDate(event.event_date) : undefined,
      venue: event.venue,
    });
  }, [event.id, event.title, event.event_date, event.venue]);

  return (
    <TouchableOpacity
      activeOpacity={0.95}
      onPress={() => router.push(`/event/${event.id}`)}
      style={styles.slide}
      accessibilityLabel={event.title}
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
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.25)", "rgba(0,0,0,0.82)"]}
        locations={[0, 0.35, 1]}
        style={styles.gradient}
      />

      {/* 컨텍스트 태그 — DICE "FEATURED" 위치 */}
      {contextLabel ? (
        <View style={[styles.contextTag, { backgroundColor: `${accentColor}25` }]}>
          {contextIcon && <Ionicons name={contextIcon} size={12} color={accentColor} />}
          <Text style={[styles.contextText, { color: accentColor }]}>
            {contextLabel}
          </Text>
        </View>
      ) : null}

      {/* 하단 콘텐츠 */}
      <View style={styles.content}>
        <Text style={[typography.h1, { color: "#FFF" }]} numberOfLines={2}>
          {event.title}
        </Text>
        <Text style={styles.metaText} numberOfLines={1}>
          {[
            event.event_date ? formatShortDate(event.event_date) : null,
            event.venue,
          ]
            .filter(Boolean)
            .join(", ")}
        </Text>
        <Text style={[typography.h4, { color: "#FFF", marginTop: 2 }]}>
          {formatPriceRange(event.min_price, event.max_price)}
        </Text>

        {/* 액션: 즐겨찾기 · 공유 — 상세 페이지와 통일 */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={handleFavorite}
            accessibilityLabel={t("event.favorite")}
            accessibilityRole="button"
          >
            <Ionicons
              name={event.is_favorited ? "heart" : "heart-outline"}
              size={20}
              color={event.is_favorited ? "#FF3366" : "rgba(255,255,255,0.85)"}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={handleShare}
            accessibilityLabel={t("event.share")}
            accessibilityRole="button"
          >
            <Ionicons name="share-outline" size={20} color="rgba(255,255,255,0.85)" />
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export function ContextCard({
  events,
  contextIcon,
  contextLabel,
  contextColor,
}: ContextCardProps) {
  ;
  const { t } = useTranslation();
  const pagerRef = useRef<PagerView>(null);
  const [page, setPage] = useState(0);
  const count = events.length;

  const goLeft = useCallback(() => {
    if (page > 0) {
      pagerRef.current?.setPage(page - 1);
    }
  }, [page]);

  const goRight = useCallback(() => {
    if (page < count - 1) {
      pagerRef.current?.setPage(page + 1);
    }
  }, [page, count]);

  if (count === 0) return null;

  return (
    <View style={styles.card}>
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={0}
        onPageSelected={(e) => setPage(e.nativeEvent.position)}
      >
        {events.map((event) => (
          <CardSlide
            key={event.id}
            event={event}
            contextIcon={contextIcon}
            contextLabel={contextLabel}
            contextColor={contextColor}
          />
        ))}
      </PagerView>

      {/* DICE 좌우 화살표 */}
      {count > 1 && (
        <>
          {page > 0 && (
            <TouchableOpacity
              style={[styles.arrow, styles.arrowLeft]}
              onPress={goLeft}
              accessibilityLabel={t("common.back")}
              accessibilityRole="button"
            >
              <Ionicons name="chevron-back" size={22} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          )}
          {page < count - 1 && (
            <TouchableOpacity
              style={[styles.arrow, styles.arrowRight]}
              onPress={goRight}
              accessibilityLabel={t("common.next")}
              accessibilityRole="button"
            >
              <Ionicons name="chevron-forward" size={22} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    height: CARD_HEIGHT,
    marginHorizontal: spacing.xl,
    borderRadius: radius.cardLg,
    overflow: "hidden",
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
  },
  contextTag: {
    position: "absolute",
    top: spacing.lg,
    left: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  contextText: {
    fontSize: 11,
    fontFamily: "Pretendard-SemiBold",
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  content: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.xl,
  },
  metaText: {
    fontSize: 13,
    fontFamily: "Pretendard-Regular",
    color: "rgba(255,255,255,0.7)",
    marginTop: 4,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.md,
  },
  actionBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  arrow: {
    position: "absolute",
    top: "50%",
    marginTop: -22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  arrowLeft: {
    left: spacing.sm,
  },
  arrowRight: {
    right: spacing.sm,
  },
});

/**
 * DiscoverCard — DICE 리디자인 (Phase 2)
 *
 * 변경사항:
 * - rgba shade → LinearGradient (하단 40%)
 * - typography.h2 → typography.display (36pt Pretendard-Black)
 * - CTA: "예매하기" → "갈래요" (discover.going)
 * - 메타: category · venue · date
 * - 추천 이유 pill (glassmorphism)
 * - Reanimated entering 애니메이션 (FadeInUp / FadeInRight)
 *
 * 인터랙션:
 * - 단탭 (CTA): 이벤트 상세로 이동
 * - 더블탭: 즐겨찾기 토글 + haptic.success()
 * - 공유 버튼: shareEvent() 호출
 * - 즐겨찾기 버튼: useToggleFavorite
 */
import { useCallback, useRef } from "react";
import {
  Pressable,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
} from "react-native";
import Animated, { FadeInUp, FadeInRight } from "react-native-reanimated";
const { width: SCREEN_W } = Dimensions.get("window");
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useToggleFavorite } from "@/hooks/useEvents";
import { shareEvent } from "@/lib/sharing";
import { success as hapticSuccess, light as hapticLight } from "@/lib/haptics";
import { trackClick, trackFavorite, trackShare } from "@/lib/analytics";
import { resolveEventImage } from "@/lib/format";
import type { Event } from "@/config/api";

const DOUBLE_TAP_MS = 280;

interface Props {
  event: Event;
  height?: number;
}

export function DiscoverCard({ event, height }: Props) {
  const cardH = height && height > 0 ? height : Dimensions.get("window").height;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const toggleFavorite = useToggleFavorite();
  const lastTapRef = useRef<number>(0);

  const handleBookNow = useCallback(() => {
    hapticLight();
    trackClick("event", event.id);
    router.push(`/event/${event.id}`);
  }, [event.id, router]);

  const handleFavorite = useCallback(() => {
    hapticSuccess();
    toggleFavorite.mutate(event.id);
    trackFavorite(event.id);
  }, [event.id, toggleFavorite]);

  const handleShare = useCallback(() => {
    shareEvent({
      eventId: event.id,
      title: event.title,
      date: event.event_date,
      venue: event.venue,
    });
    trackShare(event.id, "discover_card");
  }, [event]);

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      handleFavorite();
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  }, [handleFavorite]);

  const imageSource = resolveEventImage(event);
  const dateLabel = event.event_date
    ? new Date(event.event_date).toLocaleDateString()
    : "";

  // 메타: category · venue · date
  const metaParts = [event.category, event.venue, dateLabel].filter(Boolean);

  return (
    <Pressable
      testID="discover.card"
      style={[styles.container, { height: cardH }]}
      onPress={handleDoubleTap}
    >
      <Image
        source={{ uri: imageSource }}
        style={StyleSheet.absoluteFillObject}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={200}
      />

      {/* 하단 그라디언트 (가독성) — LinearGradient 하단 40% */}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.7)"]}
        style={styles.gradient}
        pointerEvents="none"
      />

      {/* 우측 액션 바 — Reanimated entering */}
      <Animated.View
        entering={FadeInRight.delay(300).springify()}
        style={styles.actionBar}
      >
        <TouchableOpacity
          testID="discover.card.favorite"
          style={styles.actionBtn}
          onPress={handleFavorite}
          accessibilityLabel="favorite"
          hitSlop={8}
        >
          <Ionicons
            name={(event as { is_favorited?: boolean }).is_favorited ? "heart" : "heart-outline"}
            size={28}
            color={(event as { is_favorited?: boolean }).is_favorited ? "#FF4D6A" : "#fff"}
          />
        </TouchableOpacity>
        <TouchableOpacity
          testID="discover.card.share"
          style={styles.actionBtn}
          onPress={handleShare}
          accessibilityLabel="share"
          hitSlop={8}
        >
          <Ionicons name="share-social-outline" size={26} color="#fff" />
        </TouchableOpacity>
      </Animated.View>

      {/* 하단 정보 + CTA */}
      <Animated.View style={styles.info}>
        {/* 추천 이유 pill */}
        {event.recommendation_reason && (
          <Animated.View style={styles.reasonPill}>
            <Animated.Text style={styles.reasonText} numberOfLines={2}>
              {event.recommendation_reason}
            </Animated.Text>
          </Animated.View>
        )}

        {/* 타이틀 — display (36pt Pretendard-Black) */}
        <Animated.Text
          entering={FadeInUp.delay(100).springify()}
          style={[typography.display, styles.title]}
          numberOfLines={2}
        >
          {event.title}
        </Animated.Text>

        {/* 메타: category · venue · date */}
        {metaParts.length > 0 && (
          <Animated.Text
            entering={FadeInUp.delay(200).springify()}
            style={styles.meta}
            numberOfLines={1}
          >
            {metaParts.join(" \u00B7 ")}
          </Animated.Text>
        )}

        {/* CTA — "갈래요" */}
        <TouchableOpacity
          testID="discover.card.cta"
          style={[styles.cta, { backgroundColor: colors.primary }]}
          onPress={handleBookNow}
          accessibilityLabel={t("discover.going")}
        >
          <Animated.Text style={[styles.ctaText, { color: colors.primaryForeground }]}>
            {t("discover.going")}
          </Animated.Text>
        </TouchableOpacity>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: SCREEN_W,
    backgroundColor: "#000", // Intentional: fullscreen media card always uses black background regardless of theme
  },
  gradient: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    top: "60%",
  },
  actionBar: {
    position: "absolute",
    right: spacing.lg,
    bottom: "35%",
    gap: spacing.lg,
  },
  actionBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  info: {
    position: "absolute",
    left: spacing.xl,
    right: 80,
    bottom: spacing.xxl * 1.5,
    gap: spacing.sm,
  },
  reasonPill: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: radius.xl,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  reasonText: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 12,
  },
  title: {
    color: "#fff",
  },
  meta: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 14,
  },
  cta: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.full,
    alignSelf: "flex-start",
  },
  ctaText: {
    fontSize: 16,
    fontWeight: "700",
  },
});

/**
 * /e/[slug] — 티켓오픈 알림 랜딩 (모바일)
 *
 * Consumer 웹의 `/e/[slug]`와 동일한 구조를 React Native로 포팅.
 * DICE 바텀시트 + Laylo 단일 CTA + 거대 카운트다운 + 주최자 컬러 주입.
 *
 * 디자인: docs/design/DICE_LAYLO_UI_ABSORPTION_2026-04-09.md §5
 * 플랜: docs/plans/12_MASTER_DEVELOPMENT_PLAN_2026-04-09.md §3.3
 *
 * @status LIVE (2026-04-10) — React Query 실데이터 전환 완료
 */

import { useState } from "react";
import {
  ImageBackground,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useTranslation } from "react-i18next";

import { getEventBySlug } from "@/config/api";
import { EventOpenCountdown } from "@/components/event-open/EventOpenCountdown";
import { EventOpenSubscribeSheet } from "@/components/event-open/EventOpenSubscribeSheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/common/EmptyState";

export default function EventOpenLandingScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);

  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const {
    data: event,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["event-open", slug],
    queryFn: () => getEventBySlug(slug ?? ""),
    enabled: !!slug,
  });

  // ── 로딩 상태: 스켈레톤 shimmer ──
  if (isLoading) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ headerShown: false }} />
        <StatusBar barStyle="light-content" />
        <Skeleton width="100%" height={540} borderRadius={0} />
        <View style={styles.skeletonBody}>
          <Skeleton width={200} height={40} borderRadius={8} />
          <Skeleton width={280} height={56} borderRadius={28} style={{ marginTop: 32 }} />
          <Skeleton width={160} height={14} borderRadius={4} style={{ marginTop: 16 }} />
        </View>
      </View>
    );
  }

  // ── 에러 상태 ──
  if (isError || !event) {
    return (
      <SafeAreaView style={styles.errorWrap}>
        <Stack.Screen options={{ headerShown: false }} />
        <EmptyState
          title={t("eventOpen.notFound")}
          message={t("eventOpen.notFoundDesc")}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
        <Pressable onPress={() => router.back()} style={styles.errorBtn}>
          <Text style={styles.errorBtnText}>{t("eventOpen.goBack")}</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  // ── API snake_case → 컴포넌트 매핑 ──
  const heroImage = event.image_url;
  const accent = event.brand_color ?? "#FF3366";
  const accentFg = event.brand_color_fg ?? "#FFFFFF";
  const ticketOpenAt = event.ticket_open_at;
  const subscriberCount = event.subscriber_count;

  function handleCtaPress() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetOpen(true);
  }

  return (
    <View testID="event.open.screen" style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Full-bleed hero (DICE DNA) */}
        <ImageBackground
          source={{ uri: heroImage }}
          style={styles.hero}
          imageStyle={styles.heroImage}
        >
          <LinearGradient
            colors={["transparent", "rgba(0,0,0,0.4)", "#0A0A0A"]}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={[accent + "30", "transparent"]}
            start={{ x: 0.5, y: 0.2 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />

          <SafeAreaView style={styles.heroContent}>
            <View style={styles.heroTextBlock}>
              <Text style={styles.heroBadge}>{t("eventOpen.badge")}</Text>
              <Text style={styles.heroTitle} numberOfLines={3}>
                {event.title}
              </Text>
              <Text style={styles.heroVenue}>{event.venue}</Text>
              {ticketOpenAt && (
                <Text style={styles.heroDate}>
                  {dateFormat.format(new Date(ticketOpenAt))} {t("eventOpen.openSuffix")}
                </Text>
              )}
            </View>
          </SafeAreaView>
        </ImageBackground>

        {/* 카운트다운 + CTA 섹션 */}
        <View style={styles.ctaSection}>
          {ticketOpenAt && (
            <EventOpenCountdown targetIso={ticketOpenAt} accent={accent} />
          )}

          <Pressable
            testID="event.open.cta"
            onPress={handleCtaPress}
            style={({ pressed }) => [
              styles.cta,
              {
                backgroundColor: accent,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              },
            ]}
          >
            <Text style={[styles.ctaText, { color: accentFg }]}>
              {t("eventOpen.subscribeCta")}
            </Text>
          </Pressable>

          <Text style={styles.subscriberCount}>
            {t("eventOpen.subscriberCount", { count: subscriberCount.toLocaleString() })}
          </Text>

          <Text style={styles.helpText}>
            {t("eventOpen.helpText")}
          </Text>
        </View>

        <Text style={styles.footer}>
          {t("eventOpen.poweredBy")} <Text style={styles.footerBrand}>Pickket</Text>
        </Text>
      </ScrollView>

      <EventOpenSubscribeSheet
        visible={sheetOpen}
        eventId={event.id}
        eventTitle={event.title}
        accent={accent}
        accentFg={accentFg}
        baseSubscriberCount={subscriberCount}
        onClose={() => setSheetOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0A0A0A" },
  scroll: { flexGrow: 1 },

  hero: { height: 540, justifyContent: "flex-end" },
  heroImage: { resizeMode: "cover" },
  heroContent: { paddingHorizontal: 24, paddingBottom: 32 },
  heroTextBlock: { alignItems: "center" },
  heroBadge: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2.5,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 40,
    fontWeight: "900",
    lineHeight: 44,
    letterSpacing: -1,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 24,
  },
  heroVenue: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 15,
    marginTop: 16,
  },
  heroDate: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 13,
    marginTop: 4,
  },

  ctaSection: {
    paddingHorizontal: 24,
    paddingTop: 40,
    paddingBottom: 32,
    alignItems: "center",
    gap: 32,
  },
  cta: {
    height: 56,
    width: "100%",
    maxWidth: 360,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 8,
  },
  ctaText: { fontSize: 16, fontWeight: "700" },
  subscriberCount: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    marginTop: -16,
  },
  subscriberCountStrong: {
    color: "rgba(255,255,255,0.8)",
    fontWeight: "700",
  },
  helpText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
    marginTop: -8,
  },

  footer: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 11,
    textAlign: "center",
    paddingBottom: 40,
  },
  footerBrand: { fontWeight: "700" },

  // 스켈레톤 로딩 레이아웃
  skeletonBody: {
    paddingHorizontal: 24,
    paddingTop: 40,
    alignItems: "center",
  },

  errorWrap: {
    flex: 1,
    backgroundColor: "#0A0A0A",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  errorBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginTop: 12,
  },
  errorBtnText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
});

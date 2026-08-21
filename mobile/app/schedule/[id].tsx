/**
 * 일정 상세 화면 — 개별 일정 아이템의 풀 뷰
 * ScheduleCard에서 진입, 예매 가능 시 이벤트 상세로 연결
 */
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { typography, spacing, radius } from "@/config/theme";
import { TenasiaMediaBadge } from "@/components/schedule/TenasiaMediaBadge";
import * as haptics from "@/lib/haptics";
import type { ScheduleItem } from "@/types/schedule";

// Phase A: 목 데이터에서 직접 찾기 (Phase B에서 API 연동)
import { useTodaySchedule } from "@/hooks/useScheduleFeed";

/** 일정 날짜+시각 포맷 — i18n 키를 통해 언어별 요일/날짜 형식 적용(P2-C20) */
function formatDateTime(isoString: string): string {
  const d = new Date(isoString);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const weekday = i18n.t(`schedule.weekday_${d.getDay()}`);
  const h = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  const datePart = i18n.t("schedule.dateFormat", { month: m, day, weekday });
  return `${datePart} ${h}:${min}`;
}

export default function ScheduleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  // Phase A: 오늘 일정에서 찾기 (임시)
  const { data: todayItems } = useTodaySchedule();
  const item: ScheduleItem | undefined = todayItems?.find((i) => i.id === id);

  if (!item) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("schedule.title"), headerShown: true }} />
        <View style={styles.center}>
          <Ionicons name="calendar-outline" size={48} color={colors.mutedForeground} />
          <Text style={[typography.body, { color: colors.mutedForeground, marginTop: spacing.md }]}>
            {t("schedule.empty")}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const handleBook = () => {
    if (item.event_id) {
      haptics.impactFeedback();
      router.push(`/event/${item.event_id}/booking`);
    }
  };

  return (
    <SafeAreaView testID="schedule.detail.screen" style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: item.title, headerShown: true }} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* 히어로 이미지 */}
        {item.image_url && (
          <Animated.View entering={FadeIn.springify()}>
            <Image
              source={{ uri: item.image_url }}
              style={styles.hero}
              contentFit="cover"
            />
          </Animated.View>
        )}

        <View style={styles.body}>
          {/* 소스 뱃지 */}
          <TenasiaMediaBadge source={item.source} trustScore={item.trust_score} />

          {/* 제목 */}
          <Text style={[typography.h1, { color: colors.foreground, marginTop: spacing.md }]}>
            {item.title}
          </Text>

          {/* 아티스트 */}
          <Text style={[typography.bodyLarge, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
            {item.artist_name}
          </Text>

          {/* 정보 그리드 */}
          <View style={[styles.infoGrid, { marginTop: spacing.xl }]}>
            <InfoRow icon="time-outline" label={formatDateTime(item.start_time)} colors={colors} />
            {item.venue && (
              <InfoRow icon="location-outline" label={`${item.venue}${item.location ? ` · ${item.location}` : ""}`} colors={colors} />
            )}
            <InfoRow icon="shield-checkmark-outline" label={`${t("schedule.trustScore")}: ${item.trust_score}/100`} colors={colors} />
          </View>

          {/* 태그 */}
          {item.tags && item.tags.length > 0 && (
            <View style={styles.tags}>
              {item.tags.map((tag) => (
                <View key={tag} style={[styles.tag, { backgroundColor: colors.secondary }]}>
                  <Text style={[typography.bodySmall, { color: colors.foreground }]}>#{tag}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* 하단 예매 버튼 */}
      {item.is_bookable && item.event_id && (
        <View style={[styles.bottomBar, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          <TouchableOpacity
            testID="schedule.detail.bookBtn"
            onPress={handleBook}
            style={[styles.bookBtn, { backgroundColor: colors.primary }]}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            <Ionicons name="ticket-outline" size={20} color={colors.primaryForeground} />
            <Text style={[typography.h4, { color: colors.primaryForeground, marginLeft: spacing.sm }]}>
              {t("event.booking")}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

function InfoRow({ icon, label, colors }: { icon: React.ComponentProps<typeof Ionicons>["name"]; label: string; colors: Record<string, string> }) {
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={18} color={colors.mutedForeground} />
      <Text style={[typography.body, { color: colors.foreground, marginLeft: spacing.sm, flex: 1 }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { paddingBottom: 100 },
  hero: {
    width: "100%",
    height: 240,
  },
  body: {
    padding: spacing.xl,
  },
  infoGrid: {
    gap: spacing.md,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  tag: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.xl,
    borderTopWidth: 1,
  },
  bookBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 52,
    borderRadius: radius.xl,
  },
});

/**
 * BookingActionCard — 챗 내 인라인 예매 CTA (Phase 1: 딥링크)
 * AI 응답에 예매 가능한 이벤트가 포함되면 이 카드를 표시
 * 디자인 정책: radius.xl(16), 44pt 터치, spring 애니메이션
 */
import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
// import { isFeatureEnabled } from "@/config/features";
import * as haptics from "@/lib/haptics";
import { resolveEventImage } from "@/lib/format";
import { formatKRW } from "@/lib/format";
import type { Event } from "@/config/api";

interface Props {
  event: Event;
}

export function BookingActionCard({ event }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  // Phase 1: 딥링크로 이벤트 예매 페이지 열기
  const handleBook = () => {
    haptics.impactFeedback();
    router.push(`/event/${event.id}/booking`);
  };

  const handleDetail = () => {
    haptics.lightImpact();
    router.push(`/event/${event.id}`);
  };

  const isSoldOut = event.is_sold_out === true;

  return (
    <Animated.View entering={FadeIn.springify().damping(18)}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {/* 이벤트 이미지 + 정보 */}
        <TouchableOpacity
          onPress={handleDetail}
          style={styles.infoRow}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={event.title}
        >
          <Image
            source={{ uri: resolveEventImage(event) }}
            style={styles.thumb}
            contentFit="cover"
          />
          <View style={styles.info}>
            <Text style={[typography.h4, { color: colors.foreground }]} numberOfLines={2}>
              {event.title}
            </Text>
            {event.venue && (
              <View style={styles.venueRow}>
                <Ionicons name="location-outline" size={12} color={colors.mutedForeground} />
                <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginLeft: 4 }]} numberOfLines={1}>
                  {event.venue}
                </Text>
              </View>
            )}
            {event.min_price != null && (
              <Text style={[typography.h5, { color: colors.primary, marginTop: 2 }]}>
                {formatKRW(event.min_price)}~
              </Text>
            )}
          </View>
        </TouchableOpacity>

        {/* 예매 CTA 버튼 */}
        <TouchableOpacity
          onPress={handleBook}
          disabled={isSoldOut}
          style={[
            styles.bookBtn,
            {
              backgroundColor: isSoldOut ? colors.muted : colors.primary,
            },
          ]}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={isSoldOut ? t("event.soldOut") : t("event.booking")}
        >
          <Ionicons
            name={isSoldOut ? "close-circle-outline" : "ticket-outline"}
            size={18}
            color={isSoldOut ? colors.mutedForeground : colors.primaryForeground}
          />
          <Text
            style={[
              typography.h5,
              {
                color: isSoldOut ? colors.mutedForeground : colors.primaryForeground,
                marginLeft: spacing.sm,
              },
            ]}
          >
            {isSoldOut ? t("event.soldOut") : t("event.booking")}
          </Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: "hidden",
    marginTop: spacing.sm,
  },
  infoRow: {
    flexDirection: "row",
    padding: spacing.md,
  },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    marginRight: spacing.md,
  },
  info: {
    flex: 1,
    justifyContent: "center",
  },
  venueRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
  },
  bookBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.xl,
  },
});

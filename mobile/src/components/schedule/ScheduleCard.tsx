/**
 * 일정 카드 — 개별 일정 아이템 표시
 * 디자인 정책: radius.xl(16), 44pt 터치, spring 애니메이션
 */
import { TouchableOpacity, View, Text, Image, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import * as haptics from "@/lib/haptics";
import type { ScheduleItem } from "@/types/schedule";

interface Props {
  item: ScheduleItem;
}

const CATEGORY_ICONS: Record<string, React.ComponentProps<typeof Ionicons>["name"]> = {
  concert: "musical-notes",
  fanmeeting: "people",
  broadcast: "tv",
  festival: "sparkles",
  release: "disc",
  fansign: "create",
  other: "ellipse",
};

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ScheduleCard({ item }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const handlePress = () => {
    haptics.lightImpact();
    if (item.is_bookable && item.event_id) {
      router.push(`/event/${item.event_id}`);
    } else {
      router.push(`/schedule/${item.id}`);
    }
  };

  const icon = CATEGORY_ICONS[item.category] ?? "ellipse";

  return (
    <Animated.View entering={FadeIn.springify()}>
      <TouchableOpacity
        testID={`schedule.card.${item.id}`}
        onPress={handlePress}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${item.title} - ${item.artist_name}`}
      >
        {/* 시간 + 카테고리 아이콘 */}
        <View style={styles.timeCol}>
          <Text style={[typography.h4, { color: colors.foreground }]}>
            {formatTime(item.start_time)}
          </Text>
          <Ionicons name={icon} size={16} color={colors.mutedForeground} style={styles.catIcon} />
        </View>

        {/* 메인 콘텐츠 */}
        <View style={styles.content}>
          <Text style={[typography.h4, { color: colors.foreground }]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={[typography.bodySmall, { color: colors.mutedForeground }]} numberOfLines={1}>
            {item.artist_name}
          </Text>
          {item.venue && (
            <View style={styles.venueRow}>
              <Ionicons name="location-outline" size={12} color={colors.mutedForeground} />
              <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginLeft: 4 }]} numberOfLines={1}>
                {item.venue}
              </Text>
            </View>
          )}
        </View>

        {/* 썸네일 */}
        {item.image_url ? (
          <Image source={{ uri: item.image_url }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumbPlaceholder, { backgroundColor: colors.secondary }]}>
            <Ionicons name={icon} size={20} color={colors.mutedForeground} />
          </View>
        )}

        {/* 예매 가능 뱃지 */}
        {item.is_bookable && (
          <View style={[styles.badge, { backgroundColor: colors.primary }]}>
            <Text style={[typography.micro, { color: colors.primaryForeground }]}>
              {t("schedule.bookable")}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    minHeight: 80,
  },
  timeCol: {
    width: 52,
    alignItems: "center",
    marginRight: spacing.md,
  },
  catIcon: {
    marginTop: 4,
  },
  content: {
    flex: 1,
    marginRight: spacing.md,
  },
  venueRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radius.xl,
  },
  thumbPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
});

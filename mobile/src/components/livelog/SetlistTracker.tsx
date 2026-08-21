/**
 * SetlistTracker — 공연 중 셋리스트 체크리스트
 * 곡 순서대로 표시, 현재 연주 중인 곡 하이라이트
 * 디자인 정책: radius.xl(16), 44pt 터치
 */
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import * as haptics from "@/lib/haptics";
import type { SetlistItem } from "@/types/livelog";

interface Props {
  setlist: SetlistItem[];
  currentIndex: number;
  onItemPress?: (index: number) => void;
}

export function SetlistTracker({ setlist, currentIndex, onItemPress }: Props) {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      {setlist.map((item, index) => {
        const isCurrent = index === currentIndex;
        const isPast = index < currentIndex;

        return (
          <Animated.View key={`${item.order}-${item.title}`} entering={FadeIn.springify().delay(index * 50)}>
            <TouchableOpacity
              onPress={() => {
                haptics.selectionFeedback();
                onItemPress?.(index);
              }}
              style={[
                styles.row,
                {
                  backgroundColor: isCurrent ? colors.primary + "15" : colors.card,
                  borderColor: isCurrent ? colors.primary : colors.border,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${item.order}. ${item.title}${item.is_encore ? " (Encore)" : ""}`}
            >
              {/* 순서 번호 */}
              <View style={[styles.orderBadge, { backgroundColor: isCurrent ? colors.primary : isPast ? colors.success : colors.secondary }]}>
                {isPast ? (
                  <Ionicons name="checkmark" size={14} color={colors.primaryForeground} />
                ) : (
                  <Text style={[typography.micro, { color: isCurrent ? colors.primaryForeground : colors.foreground }]}>
                    {item.order}
                  </Text>
                )}
              </View>

              {/* 곡 정보 */}
              <View style={styles.songInfo}>
                <Text
                  style={[
                    isCurrent ? typography.h4 : typography.body,
                    { color: isPast ? colors.mutedForeground : colors.foreground },
                  ]}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
                {item.is_encore && (
                  <Text style={[typography.micro, { color: colors.hot }]}>ENCORE</Text>
                )}
              </View>

              {/* 현재 연주 중 표시 */}
              {isCurrent && (
                <Ionicons name="musical-notes" size={18} color={colors.primary} />
              )}
            </TouchableOpacity>
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    minHeight: 52,
  },
  orderBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  songInfo: {
    flex: 1,
  },
});

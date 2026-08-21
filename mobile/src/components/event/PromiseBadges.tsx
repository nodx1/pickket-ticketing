import { StyleSheet, View, Text, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeInRight } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { typography, spacing } from "@/config/theme";

interface Props {
  showP1?: boolean;
  showP2?: boolean;
  showP3?: boolean;
  showP4?: boolean;
  style?: ViewStyle;
}

// Fixed badge accent colors — these are semantic promise-tier colors
// and do not change with light/dark theme. Text color on badges uses theme colors.
const BADGE_COLORS = {
  P1: "#10B981", // fair / green
  P2: "#3B82F6", // trust / blue
  P3: "#F59E0B", // waitlist / amber
  P4: "#8B5CF6", // fan proof / purple
} as const;

const PROMISES = [
  { key: "P1", i18nKey: "promise.fairPrice", icon: "cash-outline" as const, color: BADGE_COLORS.P1 },
  { key: "P2", i18nKey: "promise.lockedTicket", icon: "lock-closed" as const, color: BADGE_COLORS.P2 },
  { key: "P3", i18nKey: "promise.waitlist", icon: "people" as const, color: BADGE_COLORS.P3 },
  { key: "P4", i18nKey: "promise.proofOfFan", icon: "heart" as const, color: BADGE_COLORS.P4 },
] as const;

/** Pickket 4대 약속 — pill 배지 스트립 */
export function PromiseBadges({ showP1, showP2, showP3, showP4, style }: Props) {
  const { t } = useTranslation();
  const flags = [showP1, showP2, showP3, showP4];

  const visible = PROMISES.filter((_, i) => flags[i]);
  if (visible.length === 0) return null;

  return (
    <View style={[styles.container, style]}>
      {visible.map((p, i) => (
        <Animated.View
          key={p.key}
          entering={FadeInRight.delay(i * 80).springify()}
          style={[
            styles.pill,
            { backgroundColor: `${p.color}1F` }, // 12% opacity hex
          ]}
        >
          <Ionicons name={p.icon} size={14} color={p.color} />
          <Text style={[styles.label, { color: p.color }]}>{t(p.i18nKey)}</Text>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 9999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  label: {
    ...typography.bodySmall,
    fontWeight: "600",
  },
});

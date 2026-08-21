import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";

/** 카테고리 정의 — i18n key로 라벨 관리 */
const CATEGORIES = [
  { key: "CONCERT", icon: "🎵" },
  { key: "MUSICAL", icon: "🎭" },
  { key: "SPORTS", icon: "⚽" },
  { key: "EXHIBITION", icon: "🎨" },
  { key: "FESTIVAL", icon: "🎪" },
  { key: "THEATER", icon: "🎬" },
  { key: "FANMEETING", icon: "💜" },
  { key: "CLASSIC", icon: "🎻" },
] as const;

export function CategoryGrid() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  const handleCategory = (key: string) => {
    router.push({ pathname: "/(tabs)/tickets", params: { category: key } });
  };

  return (
    <View style={styles.container}>
      <Text style={[typography.h3, { color: colors.foreground, marginHorizontal: spacing.xl }]}>
        {t("home.categories")}
      </Text>
      <View style={styles.grid}>
        {CATEGORIES.map((cat) => (
          <TouchableOpacity
            key={cat.key}
            style={[styles.item, { backgroundColor: colors.surface }]}
            onPress={() => handleCategory(cat.key)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t(`categories.${cat.key}`)}
          >
            <Text style={styles.icon}>{cat.icon}</Text>
            <Text
              style={[typography.bodySmall, { color: colors.foreground, marginTop: spacing.xs }]}
              numberOfLines={1}
            >
              {t(`categories.${cat.key}`)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.xl,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: spacing.xl,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  item: {
    width: (Dimensions.get("window").width - spacing.xl * 2 - spacing.sm * 3) / 4,
    aspectRatio: 1,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    fontSize: 28,
  },
});

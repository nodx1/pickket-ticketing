/**
 * 글래스 헤더 — Pickket 로고 + 알림 + 검색 + 아바타
 */
import { View, TouchableOpacity, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { useAuthStore } from "@/hooks/useAuth";
import { useUnreadCount } from "@/hooks/useNotifications";
import { typography, spacing } from "@/config/theme";
import { Avatar } from "@/components/ui/Avatar";

export function GlassHeader() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useTranslation();
  // AUDIT §6 P1: 개별 selector로 불필요한 리렌더 방지
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const { data: unreadCount } = useUnreadCount();
  const hasUnread = !isGuest && (unreadCount ?? 0) > 0;

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + 4,
          backgroundColor: colors.glass,
          borderBottomColor: colors.glassBorder,
        },
      ]}
    >
      {/* 로고 */}
      <Text style={[typography.h3, { color: colors.foreground, letterSpacing: 1 }]}>
        Pickket
      </Text>

      {/* 우측 아이콘 그룹 */}
      <View style={styles.icons}>
        {/* 알림 */}
        <TouchableOpacity
          testID="home.notifications"
          style={styles.iconBtn}
          onPress={() => router.push("/notifications")}
          accessibilityLabel={t("notification.title")}
          accessibilityRole="button"
        >
          <Ionicons name="notifications-outline" size={22} color={colors.foreground} />
          {hasUnread && <View style={[styles.badge, { backgroundColor: colors.primary }]} />}
        </TouchableOpacity>

        {/* 검색 */}
        <TouchableOpacity
          testID="home.search"
          style={styles.iconBtn}
          onPress={() => router.push("/discover/feed")}
          accessibilityLabel={t("common.search")}
          accessibilityRole="button"
        >
          <Ionicons name="search-outline" size={22} color={colors.foreground} />
        </TouchableOpacity>

        {/* 아바타 */}
        <TouchableOpacity
          testID="home.avatar"
          style={styles.avatarBtn}
          onPress={() => router.push("/(tabs)/me")}
          accessibilityLabel={isGuest ? t("tabs.profile") : `${user?.name ?? ""} ${t("tabs.profile")}`.trim()}
          accessibilityRole="button"
        >
          {isGuest ? (
            <Ionicons name="person-circle-outline" size={28} color={colors.mutedForeground} />
          ) : (
            <Avatar name={user?.name ?? ""} uri={user?.avatar_url} size={28} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
  },
  icons: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

/**
 * FriendsInterested — 카드 하단 친구 관심 뱃지 (Phase C.2)
 *
 * 표시: 아바타 최대 3개 + "{name} 외 {N}명이 관심"
 * 데이터 없으면 null 반환
 */
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";

interface Friend {
  id: string;
  name: string;
  avatar_url?: string;
}

interface Props {
  friends?: Friend[];
  max?: number;
}

export function FriendsInterested({ friends, max = 3 }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  if (!friends || friends.length === 0) return null;

  const visible = friends.slice(0, max);
  const remaining = friends.length - visible.length;
  const first = friends[0];

  const label =
    friends.length === 1
      ? t("friends.interested", { name: first.name, count: 0, context: "one" })
      : t("friends.interested", {
          name: first.name,
          count: friends.length - 1,
          context: "other",
        });

  return (
    <View style={styles.container}>
      <View style={styles.avatars}>
        {visible.map((friend, idx) => (
          <View
            key={friend.id}
            style={[
              styles.avatarWrapper,
              { borderColor: colors.background, marginLeft: idx === 0 ? 0 : -10 },
            ]}
          >
            {friend.avatar_url ? (
              <Image
                source={{ uri: friend.avatar_url }}
                style={styles.avatar}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.avatar, { backgroundColor: colors.surface }]}>
                <Text style={[typography.micro, { color: colors.foreground }]}>
                  {friend.name.slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
          </View>
        ))}
        {remaining > 0 && (
          <View
            style={[
              styles.avatarWrapper,
              styles.more,
              { backgroundColor: colors.muted, borderColor: colors.background, marginLeft: -10 },
            ]}
          >
            <Text style={[typography.micro, { color: colors.foreground }]}>+{remaining}</Text>
          </View>
        )}
      </View>
      <Text
        style={[typography.bodySmall, styles.label, { color: colors.mutedForeground }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const AVATAR_SIZE = 24;
const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
  },
  avatars: {
    flexDirection: "row",
  },
  avatarWrapper: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 2,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    width: AVATAR_SIZE - 4,
    height: AVATAR_SIZE - 4,
    borderRadius: (AVATAR_SIZE - 4) / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  more: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    flex: 1,
    marginLeft: spacing.sm,
  },
});

/**
 * 친구들도 관심 있는 섹션 — 소셜 프루프 이벤트 카드
 */
import { useCallback } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { resolveEventImage } from "@/lib/format";
import type { Event } from "@/config/api";

export interface FriendInterestEvent extends Event {
  friendCount: number;
  friendNames: string[];
}

interface FriendsInterestSectionProps {
  events: FriendInterestEvent[];
}

const keyExtractor = (item: FriendInterestEvent) => item.id;

export function FriendsInterestSection({ events }: FriendsInterestSectionProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const renderItem = useCallback(({ item }: { item: FriendInterestEvent }) => (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={() => router.push(`/event/${item.id}`)}
      activeOpacity={0.7}
      accessibilityLabel={item.title}
    >
      <Image
        source={{ uri: resolveEventImage(item) }}
        style={styles.cardImage}
        contentFit="cover"
        transition={200}
      />
      <View style={styles.cardBody}>
        <Text
          style={[typography.h5, { color: colors.foreground }]}
          numberOfLines={2}
        >
          {item.title}
        </Text>
        {/* 소셜 프루프 */}
        <View style={styles.socialRow}>
          <Ionicons name="people" size={12} color={colors.violet} />
          <Text
            style={[typography.micro, { color: colors.violet, marginLeft: 4 }]}
            numberOfLines={1}
          >
            {item.friendCount === 1
              ? t("friends.interested_one", { name: item.friendNames[0] })
              : t("friends.interested_other", {
                  name: item.friendNames[0],
                  count: String(item.friendCount - 1),
                })}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  ), [colors.card, colors.border, colors.foreground, colors.violet, router, t]);

  if (events.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="people" size={18} color={colors.violet} />
        <Text style={[typography.h3, { color: colors.foreground, marginLeft: spacing.sm }]}>
          {t("home.section.friendsInterest")}
        </Text>
      </View>

      <FlatList
        horizontal
        data={events}
        keyExtractor={keyExtractor}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={renderItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.xxl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.md,
  },
  list: {
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  card: {
    width: 160,
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: "hidden",
  },
  cardImage: {
    width: "100%",
    height: 110,
  },
  cardBody: {
    padding: spacing.md,
  },
  socialRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.xs,
  },
});

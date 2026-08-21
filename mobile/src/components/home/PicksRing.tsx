/**
 * Picks 스토리 링 — 인스타 스토리 패턴
 * 원형 썸네일 가로 스크롤 + 그라디언트 링 + "+" 생성 버튼
 * Going 픽 = 점선 링 (미완성), Completed = 실선 그라디언트 링 (완성)
 */
import { FlatList, TouchableOpacity, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { spacing } from "@/config/theme";
import type { PickStatus } from "@/types/fan-stamp";

export interface PickItem {
  eventId: string;
  imageUri: string;
  label: string;
  isNew?: boolean;
  status?: PickStatus;
}

interface PicksRingProps {
  picks: PickItem[];
}

const RING_SIZE = 64;
const THUMB_SIZE = 58;
const RING_COLORS: [string, string, string] = ["#FF6B6B", "#FF8E53", "#FFA726"];
const GOING_RING_COLORS: [string, string] = ["#FFA72666", "#FF6B6B66"];
const SEEN_RING_COLORS: [string, string] = ["#555", "#666"];

export function PicksRing({ picks }: PicksRingProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const renderItem = ({ item }: { item: PickItem }) => {
    const isGoing = item.status === "going";
    const ringColors: [string, string, ...string[]] = isGoing
      ? GOING_RING_COLORS
      : item.isNew
        ? RING_COLORS
        : SEEN_RING_COLORS;

    return (
      <TouchableOpacity
        style={styles.item}
        onPress={() => router.push(`/fan-stamp/${item.eventId}`)}
        accessibilityLabel={item.label}
        accessibilityRole="button"
      >
        {isGoing ? (
          // Going 픽: 점선 링 (미완성 느낌)
          <View style={[styles.goingRing, { borderColor: RING_COLORS[0] }]}>
            <View style={[styles.thumbWrap, { backgroundColor: colors.background }]}>
              <Image source={{ uri: item.imageUri }} style={styles.thumb} contentFit="cover" />
            </View>
          </View>
        ) : (
          // Completed 픽: 실선 그라디언트 링
          <LinearGradient colors={ringColors} style={styles.ring} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
            <View style={[styles.thumbWrap, { backgroundColor: colors.background }]}>
              <Image source={{ uri: item.imageUri }} style={styles.thumb} contentFit="cover" />
            </View>
          </LinearGradient>
        )}
        <Text style={[styles.label, { color: isGoing ? RING_COLORS[0] : colors.mutedForeground }]} numberOfLines={1}>
          {item.label}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View>
      {/* 헤더: 제목 + 전체보기 */}
      {picks.length > 0 && (
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>{t("picks.title")}</Text>
          <TouchableOpacity onPress={() => router.push("/fan-stamp/collection")}>
            <Text style={[styles.headerLink, { color: colors.primary }]}>{t("common.seeAll")} →</Text>
          </TouchableOpacity>
        </View>
      )}
      <FlatList
        horizontal
        data={picks}
        keyExtractor={(item) => item.eventId}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <TouchableOpacity
            style={styles.item}
            onPress={() => router.push("/fan-stamp/new")}
            accessibilityLabel={t("picks.create")}
            accessibilityRole="button"
          >
            <View style={[styles.addRing, { borderColor: colors.primary }]}>
              <Ionicons name="add" size={26} color={colors.primary} />
            </View>
            <Text style={[styles.label, { color: colors.primary }]} numberOfLines={1}>
              {t("picks.new")}
            </Text>
          </TouchableOpacity>
        }
        renderItem={renderItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  item: {
    alignItems: "center",
    width: RING_SIZE + 8,
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  goingRing: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 2,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbWrap: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumb: {
    width: THUMB_SIZE - 2,
    height: THUMB_SIZE - 2,
    borderRadius: (THUMB_SIZE - 2) / 2,
  },
  addRing: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 2,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontSize: 11,
    marginTop: 4,
    textAlign: "center",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.xs,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
  headerLink: {
    fontSize: 12,
    fontWeight: "600",
  },
});

/**
 * Pick Detail Viewer — 풀스크린 뷰어 + 스와이프 + 넘버링 뱃지 + 액션바
 * PicksRing에서 기존 픽 탭 시 진입
 */
import { useCallback,  } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Dimensions,
  Alert,
  Share,
} from "react-native";
import { Image } from "expo-image";
import Animated, {  SlideInUp } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import type { FanStamp } from "@/types/fan-stamp";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const IMAGE_HEIGHT = SCREEN_HEIGHT * 0.6;

interface PickDetailViewerProps {
  picks: FanStamp[];
  initialIndex?: number;
  eventTitle: string;
  eventDate: string;
  venue: string;
  fanLevel?: number;
  onEdit?: (pick: FanStamp) => void;
  onDelete?: (pickId: string) => void;
}

export function PickDetailViewer({
  picks,
  initialIndex = 0,
  eventTitle,
  eventDate,
  venue,
  fanLevel,
  onEdit,
  onDelete,
}: PickDetailViewerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const handleShare = useCallback(
    async (pick: FanStamp) => {
      const sequenceText = pick.sequence_number
        ? ` #${pick.sequence_number}${t("picks.sequenceLabel")}`
        : "";
      await Share.share({
        message: `${eventTitle}${sequenceText} — pickket.kr`,
      });
    },
    [eventTitle, t],
  );

  const handleDelete = useCallback(
    (pickId: string) => {
      Alert.alert(t("picks.deleteConfirm"), "", [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.confirm"),
          style: "destructive",
          onPress: () => onDelete?.(pickId),
        },
      ]);
    },
    [t, onDelete],
  );

  const statusBadge = useCallback(
    (pick: FanStamp) => {
      if (pick.status === "going") {
        return (
          <View style={[styles.statusBadge, { backgroundColor: "#FF6B6B22" }]}>
            <Text style={[styles.statusText, { color: "#FF6B6B" }]}>
              {t("picks.going")}
            </Text>
          </View>
        );
      }
      return null;
    },
    [t],
  );

  const renderImage = useCallback(
    ({ item }: { item: FanStamp }) => (
      <View style={styles.imageSlide}>
        <Image
          source={{ uri: item.imageUri }}
          style={styles.image}
          contentFit="cover"
        />
        {item.status === "going" && (
          <View style={styles.goingOverlay}>
            <Text style={styles.goingText}>{t("picks.going")}</Text>
          </View>
        )}
      </View>
    ),
    [t],
  );

  const currentPick = picks[initialIndex] ?? picks[0];
  if (!currentPick) return null;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* 이미지 스와이프 */}
      <FlatList
        data={picks}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={initialIndex}
        getItemLayout={(_, index) => ({
          length: SCREEN_WIDTH,
          offset: SCREEN_WIDTH * index,
          index,
        })}
        keyExtractor={(item) => item.id}
        renderItem={renderImage}
      />

      {/* 이벤트 정보 + 넘버링 뱃지 */}
      <Animated.View
        entering={SlideInUp.springify().damping(18)}
        style={[styles.infoSection, { backgroundColor: colors.background }]}
      >
        <View style={styles.infoRow}>
          <View style={styles.infoTextWrap}>
            <Text style={[typography.h3, { color: colors.foreground }]} numberOfLines={1}>
              {eventTitle}
            </Text>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: 2 }]}>
              {eventDate} · {venue}
            </Text>
          </View>
          {statusBadge(currentPick)}
        </View>

        {/* 팬 레벨 + 넘버링 */}
        <View style={styles.badgeRow}>
          {fanLevel != null && fanLevel > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.primary + "18" }]}>
              <Ionicons name="flame" size={14} color={colors.primary} />
              <Text style={[styles.badgeText, { color: colors.primary }]}>
                {t("picks.fanLevelBadge", { level: String(fanLevel) })}
              </Text>
            </View>
          )}
          {currentPick.sequence_number != null && (
            <View style={[styles.badge, { backgroundColor: "#FFD70022" }]}>
              <Text style={[styles.badgeText, { color: "#E6A800" }]}>
                #{currentPick.sequence_number}{t("picks.sequenceLabel")}
              </Text>
            </View>
          )}
          {currentPick.tagged_friends && currentPick.tagged_friends.length > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.card }]}>
              <Ionicons name="people" size={14} color={colors.mutedForeground} />
              <Text style={[styles.badgeText, { color: colors.mutedForeground }]}>
                +{currentPick.tagged_friends.length}
              </Text>
            </View>
          )}
        </View>

        {/* 액션바 */}
        <View style={styles.actionBar}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.card }]}
            onPress={() => handleShare(currentPick)}
            accessibilityLabel={t("common.share")}
          >
            <Ionicons name="share-outline" size={20} color={colors.foreground} />
            <Text style={[styles.actionLabel, { color: colors.foreground }]}>
              {t("common.share")}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.card }]}
            onPress={() => handleShare(currentPick)}
            accessibilityLabel={t("picks.shareInsta")}
          >
            <Ionicons name="logo-instagram" size={20} color="#E1306C" />
            <Text style={[styles.actionLabel, { color: colors.foreground }]}>
              {t("picks.shareInsta")}
            </Text>
          </TouchableOpacity>

          {onEdit && currentPick.status !== "going" && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.card }]}
              onPress={() => onEdit(currentPick)}
              accessibilityLabel={t("picks.edit")}
            >
              <Ionicons name="create-outline" size={20} color={colors.foreground} />
              <Text style={[styles.actionLabel, { color: colors.foreground }]}>
                {t("picks.edit")}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.card }]}
            onPress={() => handleDelete(currentPick.id)}
            accessibilityLabel={t("common.delete")}
          >
            <Ionicons name="trash-outline" size={20} color={colors.destructive} />
            <Text style={[styles.actionLabel, { color: colors.destructive }]}>
              {t("common.delete")}
            </Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  imageSlide: {
    width: SCREEN_WIDTH,
    height: IMAGE_HEIGHT,
  },
  image: {
    width: SCREEN_WIDTH,
    height: IMAGE_HEIGHT,
  },
  goingOverlay: {
    position: "absolute",
    top: spacing.lg,
    right: spacing.lg,
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  goingText: {
    color: "#FFF",
    fontSize: 12,
    fontWeight: "700",
  },
  infoSection: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  infoTextWrap: { flex: 1, marginRight: spacing.md },
  statusBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  statusText: { fontSize: 12, fontWeight: "700" },
  badgeRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
    flexWrap: "wrap",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  badgeText: { fontSize: 12, fontWeight: "600" },
  actionBar: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xl,
    flexWrap: "wrap",
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
  },
  actionLabel: { fontSize: 13, fontWeight: "600" },
});

/**
 * 이벤트 상세 내 픽 갤러리 섹션
 * 이벤트 상세 페이지 하단에 "이 공연의 픽 N개" 가로 스크롤 표시
 */
import { useCallback } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { usePicksByEvent } from "@/hooks/usePicks";
import type { FanStamp } from "@/types/fan-stamp";

const THUMB_SIZE = 72;

interface PickEventGalleryProps {
  eventId: string;
}

export function PickEventGallery({ eventId }: PickEventGalleryProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { picks } = usePicksByEvent(eventId);

  const handlePress = useCallback(
    (pick: FanStamp) => {
      router.push(`/fan-stamp/${pick.eventId}`);
    },
    [router],
  );

  if (picks.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={[typography.h5, { color: colors.foreground }]}>
          {t("picks.total", { count: picks.length })}
        </Text>
      </View>
      <FlatList
        horizontal
        data={picks}
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.item}
            onPress={() => handlePress(item)}
            activeOpacity={0.8}
          >
            <Image
              source={{ uri: item.imageUri }}
              style={[styles.thumb, { borderColor: colors.border }]}
              contentFit="cover"
            />
            {item.sequence_number != null && (
              <Text style={[styles.seqLabel, { color: colors.mutedForeground }]}>
                #{item.sequence_number}
              </Text>
            )}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.xl,
  },
  header: {
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.sm,
  },
  list: {
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  item: {
    alignItems: "center",
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  seqLabel: {
    fontSize: 10,
    marginTop: 2,
    fontWeight: "600",
  },
});

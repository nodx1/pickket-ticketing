/**
 * ArtistChip — 아티스트 정규화 뱃지 (텐아시아 연동)
 * 일정 카드 내에서 아티스트명 + 확인된 소스 표시
 */
import { View, Text, StyleSheet } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import type { ScheduleSource } from "@/types/schedule";

interface Props {
  artistName: string;
  source: ScheduleSource;
  verified?: boolean;
}

export function ArtistChip({ artistName, source: _source, verified = false }: Props) {
  const { colors } = useTheme();

  return (
    <View style={[styles.chip, { backgroundColor: colors.secondary }]}>
      <Text style={[typography.bodySmall, { color: colors.foreground }]} numberOfLines={1}>
        {artistName}
      </Text>
      {verified && (
        <Ionicons
          name="checkmark-circle"
          size={14}
          color={colors.success}
          style={styles.verifiedIcon}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    alignSelf: "flex-start",
  },
  verifiedIcon: {
    marginLeft: 4,
  },
});

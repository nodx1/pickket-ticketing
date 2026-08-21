/**
 * LiveLogEntry — 라이브 로그 개별 엔트리
 * 사진, 메모, 하이라이트 등 타입별 표시
 */
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import type { LiveLogEntry as LiveLogEntryType } from "@/types/livelog";

interface Props {
  entry: LiveLogEntryType;
}

const TYPE_ICON: Record<string, React.ComponentProps<typeof Ionicons>["name"]> = {
  setlist: "musical-notes",
  photo: "camera",
  note: "create",
  rating: "star",
  highlight: "sparkles",
};

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function LiveLogEntryCard({ entry }: Props) {
  const { colors } = useTheme();
  const icon = TYPE_ICON[entry.type] ?? "ellipse";

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Ionicons name={icon} size={16} color={colors.primary} />
        <Text style={[typography.micro, { color: colors.mutedForeground, marginLeft: spacing.xs }]}>
          {formatTime(entry.timestamp)}
        </Text>
        {entry.song_title && (
          <Text style={[typography.bodySmall, { color: colors.primary, marginLeft: spacing.sm }]}>
            {entry.song_title}
          </Text>
        )}
      </View>

      <Text style={[typography.body, { color: colors.foreground, marginTop: spacing.xs }]}>
        {entry.content}
      </Text>

      {entry.image_url && (
        <Image
          source={{ uri: entry.image_url }}
          style={styles.image}
          contentFit="cover"
        />
      )}

      {entry.rating != null && (
        <View style={styles.ratingRow}>
          {[1, 2, 3, 4, 5].map((star) => (
            <Ionicons
              key={star}
              name={star <= entry.rating! ? "star" : "star-outline"}
              size={16}
              color={star <= entry.rating! ? colors.warning : colors.mutedForeground}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  image: {
    width: "100%",
    height: 180,
    borderRadius: radius.xl,
    marginTop: spacing.sm,
  },
  ratingRow: {
    flexDirection: "row",
    gap: 2,
    marginTop: spacing.xs,
  },
});

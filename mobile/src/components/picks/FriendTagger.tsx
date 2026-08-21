/**
 * 친구 태그 선택 UI — 픽 생성 시 "같이 간 친구" 태그
 * 최대 5명까지 선택 가능
 */
import { useCallback, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { Avatar } from "@/components/ui/Avatar";

export interface TaggableFriend {
  id: string;
  name: string;
  avatar_url?: string;
}

interface FriendTaggerProps {
  friends: TaggableFriend[];
  selected: TaggableFriend[];
  onSelect: (friend: TaggableFriend) => void;
  onDeselect: (friendId: string) => void;
  maxTags?: number;
}

const MAX_DEFAULT = 5;

export function FriendTagger({
  friends,
  selected,
  onSelect,
  onDeselect,
  maxTags = MAX_DEFAULT,
}: FriendTaggerProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const filtered = friends.filter(
    (f) =>
      f.name.toLowerCase().includes(search.toLowerCase()) &&
      !selected.some((s) => s.id === f.id),
  );

  const handleSelect = useCallback(
    (friend: TaggableFriend) => {
      if (selected.length >= maxTags) return;
      onSelect(friend);
    },
    [selected.length, maxTags, onSelect],
  );

  return (
    <View style={styles.container}>
      {/* 선택된 친구 칩 */}
      {selected.length > 0 && (
        <View style={styles.selectedRow}>
          {selected.map((f) => (
            <TouchableOpacity
              key={f.id}
              style={[styles.chip, { backgroundColor: colors.primary + "18" }]}
              onPress={() => onDeselect(f.id)}
            >
              <Avatar name={f.name} uri={f.avatar_url} size={20} />
              <Text style={[styles.chipText, { color: colors.primary }]}>{f.name}</Text>
              <Ionicons name="close-circle" size={16} color={colors.primary} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* 헤더 */}
      <View style={styles.headerRow}>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
          {t("picks.friendTag")}
        </Text>
        <Text style={[typography.micro, { color: colors.mutedForeground }]}>
          {selected.length}/{maxTags}
        </Text>
      </View>

      {/* 검색 */}
      <TextInput
        style={[styles.searchInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
        placeholder={t("common.search")}
        placeholderTextColor={colors.mutedForeground}
        value={search}
        onChangeText={setSearch}
      />

      {/* 친구 목록 */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        style={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.friendItem}
            onPress={() => handleSelect(item)}
            disabled={selected.length >= maxTags}
          >
            <Avatar name={item.name} uri={item.avatar_url} size={32} />
            <Text style={[typography.body, { color: colors.foreground, flex: 1 }]}>{item.name}</Text>
            <Ionicons
              name="add-circle-outline"
              size={22}
              color={selected.length >= maxTags ? colors.mutedForeground : colors.primary}
            />
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  selectedRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  searchInput: {
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
  list: {
    flex: 1,
  },
  friendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
});

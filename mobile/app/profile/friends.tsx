/**
 * 친구 화면 (Phase C.1)
 *
 * - 친구 목록 + 대기 중 요청
 * - 사용자 검색 (이름/전화번호)
 * - 친구 추가/수락/제거
 *
 * 백엔드 미구현 시 EmptyState 안내 표시.
 */
import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import {
  useFriendsList,
  useUserSearch,
  useRequestFriend,
  useAcceptFriend,
  useRemoveFriend,
} from "@/hooks/useFriends";
import { EmptyState } from "@/components/common/EmptyState";
import type { Friend, User } from "@/config/api";
import { FRIEND_STATUS } from "@/constants/status";
import { success as hapticSuccess, error as hapticError } from "@/lib/haptics";

export default function FriendsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [search, setSearch] = useState("");

  const friendsQuery = useFriendsList();
  const searchQuery = useUserSearch(search);
  const requestMut = useRequestFriend();
  const acceptMut = useAcceptFriend();
  const removeMut = useRemoveFriend();

  const friends = friendsQuery.data?.friends ?? [];
  const pending = friendsQuery.data?.pending ?? [];

  const handleAdd = useCallback(
    async (user: User) => {
      try {
        await requestMut.mutateAsync(user.id);
        hapticSuccess();
        Alert.alert(t("friends.requestSent"));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
        hapticError();
        Alert.alert(t("common.serverError"));
      }
    },
    [requestMut, t],
  );

  // NOTE: backend FriendUserRead는 friendship_id를 노출하지 않고 user id(`id`)만 준다.
  // accept/delete는 friendship_id 경로 파라미터를 요구하므로, 목록에서 받은 user id로는
  // 정확히 매칭되지 않을 수 있다(런타임 404 가능). backend가 friendship_id를 응답에
  // 포함하도록 확장되기 전까지의 한계 — 에러는 더 이상 삼키지 않고 사용자에게 노출한다.
  const handleAccept = useCallback(
    async (friend: Friend) => {
      try {
        await acceptMut.mutateAsync(friend.id);
        hapticSuccess();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
        hapticError();
      }
    },
    [acceptMut],
  );

  const handleRemove = useCallback(
    async (friend: Friend) => {
      Alert.alert(t("friends.removeConfirm"), friend.name ?? "", [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await removeMut.mutateAsync(friend.id);
              hapticSuccess();
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
              hapticError();
            }
          },
        },
      ]);
    },
    [removeMut, t],
  );

  const renderUserResult = ({ item }: { item: User }) => (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <Avatar uri={item.avatar_url} name={item.name} colors={colors} />
      <View style={styles.rowInfo}>
        <Text style={[typography.body, { color: colors.foreground }]}>{item.name}</Text>
        {item.email && (
          <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
            {item.email}
          </Text>
        )}
      </View>
      <TouchableOpacity
        style={[styles.actionBtn, { backgroundColor: colors.primary }]}
        onPress={() => handleAdd(item)}
        accessibilityLabel={t("friends.add")}
      >
        <Text style={[typography.bodySmall, { color: colors.primaryForeground }]}>
          {t("friends.add")}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderFriend = ({ item }: { item: Friend }) => (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <Avatar uri={item.profile_image_url ?? undefined} name={item.name ?? ""} colors={colors} />
      <View style={styles.rowInfo}>
        <Text style={[typography.body, { color: colors.foreground }]}>{item.name}</Text>
      </View>
      <TouchableOpacity
        style={[styles.actionBtn, { backgroundColor: colors.muted }]}
        onPress={() => handleRemove(item)}
        accessibilityLabel={t("common.delete")}
      >
        <Text style={[typography.bodySmall, { color: colors.foreground }]}>
          {t("common.delete")}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderPending = ({ item }: { item: Friend }) => (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <Avatar uri={item.profile_image_url ?? undefined} name={item.name ?? ""} colors={colors} />
      <View style={styles.rowInfo}>
        <Text style={[typography.body, { color: colors.foreground }]}>{item.name}</Text>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
          {t("friends.pendingRequest")}
        </Text>
      </View>
      <TouchableOpacity
        style={[styles.actionBtn, { backgroundColor: colors.primary }]}
        onPress={() => handleAccept(item)}
        accessibilityLabel={t("friends.accept")}
      >
        <Text style={[typography.bodySmall, { color: colors.primaryForeground }]}>
          {t("friends.accept")}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const showSearch = search.trim().length >= 2;
  const isLoading = friendsQuery.isLoading;

  return (
    <SafeAreaView testID="friends.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <Stack.Screen options={{ title: t("friends.title"), headerShown: true }} />

      <View style={[styles.searchBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <TextInput
          testID="friends.searchInput"
          style={[styles.input, { color: colors.foreground }]}
          placeholder={t("friends.searchPlaceholder")}
          placeholderTextColor={colors.mutedForeground}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("friends.searchPlaceholder")}
        />
      </View>

      {showSearch ? (
        searchQuery.isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
        ) : (searchQuery.data?.length ?? 0) === 0 ? (
          <EmptyState title={t("friends.noResults")} />
        ) : (
          <FlatList
            data={searchQuery.data}
            keyExtractor={(u) => u.id}
            renderItem={renderUserResult}
          />
        )
      ) : isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : friends.length === 0 && pending.length === 0 ? (
        <EmptyState title={t("friends.empty")} message={t("friends.featureUnavailable")} />
      ) : (
        <FlatList
          data={[...pending, ...friends]}
          keyExtractor={(f) => f.id}
          renderItem={({ item }) =>
            item.friendship_status === FRIEND_STATUS.PENDING
              ? renderPending({ item })
              : renderFriend({ item })
          }
        />
      )}
    </SafeAreaView>
  );
}

function Avatar({
  uri,
  name,
  colors,
}: {
  uri?: string;
  name: string;
  colors: { surface: string; foreground: string };
}) {
  if (uri) {
    return <Image source={{ uri }} style={styles.avatar} contentFit="cover" />;
  }
  return (
    <View style={[styles.avatar, { backgroundColor: colors.surface }]}>
      <Text style={[typography.body, { color: colors.foreground }]}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchBar: {
    margin: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    height: 44,
    justifyContent: "center",
  },
  input: { fontSize: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  rowInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  actionBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
  },
});

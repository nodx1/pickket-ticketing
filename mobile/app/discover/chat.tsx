/**
 * Discover Chat — 대화형 AI 컨시어지 (Phase B.2)
 *
 * 흐름:
 * 1. 초기: greeting AI 메시지
 * 2. 사용자 입력 (텍스트 or 음성) → user 메시지 append
 * 3. discover() 호출 → ai 메시지 append (events + intent)
 * 4. refinement chip 탭 → 쿼리 덧붙여 재검색
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { SearchBar } from "@/components/search/SearchBar";
import { AIChatMessage, type ChatMessage } from "@/components/discover/AIChatMessage";
import { RefinementChips, type Chip } from "@/components/discover/RefinementChips";
import { discover } from "@/config/api";
import { trackScreenView, trackSearch } from "@/lib/analytics";
import { error as hapticError } from "@/lib/haptics";
import { getPreferenceContext, recordKeyword } from "@/lib/preference-memory";

// REFINEMENT_CHIPS는 컴포넌트 외부에서 정적으로 정의할 수 없다 — i18n t()가 필요하기 때문.
// 훅으로 이동하거나 useMemo로 렌더 시점에 생성해야 한다(P2-C19).
// id만 정적으로 정의하고 label/append는 t()로 런타임에 해석.
const CHIP_IDS = ["cheaper", "nearby", "weekend", "tonight"] as const;
type ChipId = (typeof CHIP_IDS)[number];

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function DiscoverChatScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  // i18n 처리된 chip — 언어 변경 시 자동 재계산(P2-C19)
  const refinementChips: Chip[] = useMemo(
    () =>
      CHIP_IDS.map((id: ChipId) => ({
        id,
        label: t(`ai.chip.${id}.label`),
        append: t(`ai.chip.${id}.append`),
      })),
    [t],
  );
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "greeting",
      role: "ai",
      text: t("ai.greeting"),
    },
  ]);
  const [thinking, setThinking] = useState(false);

  useState(() => {
    trackScreenView("discover_chat");
  });

  const runQuery = useCallback(
    async (rawQuery: string) => {
      const q = rawQuery.trim();
      if (!q) return;

      const userMsg: ChatMessage = { id: genId(), role: "user", text: q };
      setMessages((prev) => [...prev, userMsg]);
      setQuery("");
      setThinking(true);

      try {
        const user_context = await getPreferenceContext();
        const result = await discover(q, { user_context });
        trackSearch(q, result.events.length);
        recordKeyword(q);
        const aiMsg: ChatMessage = {
          id: genId(),
          role: "ai",
          text:
            result.suggestion ??
            (result.events.length > 0
              ? t("search.resultCount", { count: result.events.length })
              : t("search.noResults")),
          events: result.events,
          intent: result.parsed_intent as unknown as Record<string, unknown>,
        };
        setMessages((prev) => [...prev, aiMsg]);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
        hapticError();
        setMessages((prev) => [
          ...prev,
          {
            id: genId(),
            role: "ai",
            text: t("common.serverError"),
          },
        ]);
      } finally {
        setThinking(false);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
      }
    },
    [t],
  );

  const handleSubmit = useCallback(() => {
    runQuery(query);
  }, [query, runQuery]);

  const handleChipPress = useCallback(
    (chip: Chip) => {
      // 최근 user 메시지 기반으로 덧붙이기
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const base = lastUser?.text ?? "";
      runQuery(`${base} ${chip.append}`.trim());
    },
    [messages, runQuery],
  );

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => <AIChatMessage message={item} />,
    [],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.background }]}
      edges={["top", "bottom"]}
    >
      <Stack.Screen options={{ title: t("tabs.discover"), headerShown: true }} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 80 : 0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.list}
          ListFooterComponent={
            thinking ? (
              <View style={styles.thinking}>
                <ActivityIndicator color={colors.primary} />
                <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginLeft: spacing.sm }]}>
                  {t("ai.thinking")}
                </Text>
              </View>
            ) : null
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />

        <RefinementChips chips={refinementChips} onPress={handleChipPress} />

        <View style={[styles.inputBar, { borderTopColor: colors.border }]}>
          <SearchBar
            value={query}
            onChangeText={setQuery}
            onSubmit={handleSubmit}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  list: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  thinking: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  inputBar: {
    borderTopWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});

/**
 * 언어 설정
 */
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LANGUAGES = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
] as const;

const LANG_STORAGE_KEY = "user_language";

export default function LanguageScreen() {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();

  const handleSelect = async (code: string) => {
    await i18n.changeLanguage(code);
    await AsyncStorage.setItem(LANG_STORAGE_KEY, code);
  };

  return (
    <SafeAreaView testID="language.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("profile.language") }} />

      <View style={styles.body}>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {LANGUAGES.map((lang, idx) => (
            <View key={lang.code}>
              {idx > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
              <TouchableOpacity
                testID={`language.option.${lang.code}`}
                style={styles.langRow}
                onPress={() => handleSelect(lang.code)}
                activeOpacity={0.6}
                accessibilityLabel={lang.label}
                accessibilityRole="radio"
                accessibilityState={{ selected: i18n.language?.startsWith(lang.code) }}
              >
                <Text style={[typography.body, { color: colors.foreground }]}>{lang.label}</Text>
                {i18n.language?.startsWith(lang.code) && (
                  <Text style={[typography.body, { color: colors.primary }]}>✓</Text>
                )}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: {
    padding: spacing.xl,
  },
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: "hidden",
  },
  langRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  divider: {
    height: 1,
  },
});

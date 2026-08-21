/**
 * 설정 / 프로필 수정
 */
import { useState, useCallback } from "react";
import { View, Text, ScrollView, Alert, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useAuthStore } from "@/hooks/useAuth";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export default function SettingsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);

  const [name, setName] = useState(user?.name ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      Alert.alert(t("common.error"), t("validation.nameRequired"));
      return;
    }

    setSaving(true);
    try {
      await updateProfile({
        name: name.trim(),
        bio: bio.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      Alert.alert(t("common.confirm"), t("profile.saved"), [
        { text: t("common.confirm"), onPress: () => router.back() },
      ]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t("common.serverError");
      Alert.alert(t("common.error"), msg);
    } finally {
      setSaving(false);
    }
  }, [name, bio, phone, updateProfile, router, t]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("profile.editProfile") }} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeIn.springify()}>
        {/* 이메일 (읽기 전용) */}
        <Text style={[typography.h5, { color: colors.mutedForeground, marginBottom: spacing.xs }]}>
          {t("auth.login.email")}
        </Text>
        <View style={[styles.readOnly, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Text style={[typography.body, { color: colors.mutedForeground }]}>{user?.email}</Text>
        </View>

        {/* 이름 */}
        <Text style={[typography.h5, { color: colors.mutedForeground, marginTop: spacing.lg, marginBottom: spacing.xs }]}>
          {t("auth.register.name")}
        </Text>
        <Input
          value={name}
          onChangeText={setName}
          placeholder={t("auth.register.name")}
          maxLength={100}
        />

        {/* 전화번호 */}
        <Text style={[typography.h5, { color: colors.mutedForeground, marginTop: spacing.lg, marginBottom: spacing.xs }]}>
          {t("profile.phone")}
        </Text>
        <Input
          value={phone}
          onChangeText={setPhone}
          placeholder="010-1234-5678"
          keyboardType="phone-pad"
          maxLength={20}
        />

        {/* 자기소개 */}
        <Text style={[typography.h5, { color: colors.mutedForeground, marginTop: spacing.lg, marginBottom: spacing.xs }]}>
          {t("profile.bio")}
        </Text>
        <Input
          value={bio}
          onChangeText={setBio}
          placeholder={t("profile.bioPlaceholder")}
          multiline
          maxLength={500}
          style={{ minHeight: 80, textAlignVertical: "top" }}
        />

        <Button
          title={saving ? t("booking.processing") : t("common.save")}
          onPress={handleSave}
          disabled={saving}
          size="lg"
          style={{ marginTop: spacing.xl }}
        />
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: {
    padding: spacing.xl,
  },
  readOnly: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
});

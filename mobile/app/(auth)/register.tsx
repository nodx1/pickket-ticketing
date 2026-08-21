import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link } from "expo-router";
import { useTranslation } from "react-i18next";
import { isAxiosError } from "axios";
import { useTheme } from "@/hooks/useTheme";
import { useAuthStore } from "@/hooks/useAuth";

const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d).{8,}$/;

export default function RegisterScreen() {
  const { t } = useTranslation();
  const { colors, typography, spacing, radius } = useTheme();
  const register = useAuthStore((s) => s.register);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t("validation.nameRequired");
    if (!email.trim()) next.email = t("validation.emailRequired");
    else if (!/\S+@\S+\.\S+/.test(email)) next.email = t("validation.emailInvalid");
    if (!password) next.password = t("validation.passwordRequired");
    else if (!PASSWORD_REGEX.test(password)) next.password = t("auth.register.passwordRule");
    if (password !== passwordConfirm) next.passwordConfirm = t("validation.passwordMismatch");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleRegister() {
    if (!validate()) return;
    setIsLoading(true);
    try {
      await register({ email: email.trim(), password, name: name.trim() });
      // AuthGate가 user 상태 변경 감지 후 자동으로 (tabs)로 라우팅
    } catch (err: unknown) {
      let message: string;
      if (isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 409) message = t("validation.emailInvalid"); // already exists
        else if (status === 404 || status === 502 || status === 503)
          message = t("auth.login.serverUnavailable");
        else if (!err.response) message = t("auth.login.networkError");
        else message = err instanceof Error ? err.message : t("common.error");
      } else {
        message = err instanceof Error ? err.message : t("common.error");
      }
      Alert.alert(t("auth.register.failed"), message);
    } finally {
      setIsLoading(false);
    }
  }

  function clearError(field: string) {
    setErrors((p) => ({ ...p, [field]: undefined }));
  }

  const fields = [
    { key: "name", label: t("auth.register.name"), value: name, set: setName, secure: false, keyboard: "default" as const },
    { key: "email", label: t("auth.register.email"), value: email, set: setEmail, secure: false, keyboard: "email-address" as const },
    { key: "password", label: t("auth.register.password"), value: password, set: setPassword, secure: true, keyboard: "default" as const },
    { key: "passwordConfirm", label: t("auth.register.passwordConfirm"), value: passwordConfirm, set: setPasswordConfirm, secure: true, keyboard: "default" as const },
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {/* 헤더 */}
          <View style={styles.header}>
            <Text style={[typography.h1, { color: colors.primary }]}>
              {t("auth.register.title")}
            </Text>
          </View>

          {/* 폼 */}
          <View style={[styles.form, { gap: spacing.lg }]}>
            {fields.map((f) => (
              <View key={f.key}>
                <Text style={[typography.h5, { color: colors.foreground, marginBottom: spacing.xs }]}>
                  {f.label}
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.secondary,
                      borderColor: errors[f.key] ? colors.destructive : colors.border,
                      color: colors.foreground,
                      borderRadius: radius.md,
                      paddingHorizontal: spacing.lg,
                    },
                  ]}
                  testID={`register-${f.key}-input`}
                  accessibilityLabel={f.label}
                  placeholderTextColor={colors.mutedForeground}
                  value={f.value}
                  onChangeText={(v) => { f.set(v); clearError(f.key); }}
                  secureTextEntry={f.secure}
                  keyboardType={f.keyboard}
                  autoCapitalize={f.key === "name" ? "words" : "none"}
                  autoCorrect={false}
                  editable={!isLoading}
                />
                {errors[f.key] && (
                  <Text style={[typography.bodySmall, { color: colors.destructive, marginTop: spacing.xs }]}>
                    {errors[f.key]}
                  </Text>
                )}
              </View>
            ))}

            {/* 비밀번호 규칙 안내 */}
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
              {t("auth.register.passwordRule")}
            </Text>

            {/* 가입 버튼 */}
            <TouchableOpacity
              style={[
                styles.button,
                {
                  backgroundColor: colors.primary,
                  borderRadius: radius.full,
                  height: 48,
                  opacity: isLoading ? 0.7 : 1,
                },
              ]}
              testID="register-button"
              accessibilityLabel={t("auth.register.submit")}
              accessibilityRole="button"
              onPress={handleRegister}
              disabled={isLoading}
              activeOpacity={0.8}
            >
              {isLoading ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[typography.h4, { color: colors.primaryForeground }]}>
                  {t("auth.register.submit")}
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {/* 로그인 링크 */}
          <View style={styles.footer}>
            <Text style={[typography.body, { color: colors.mutedForeground }]}>
              {t("auth.register.hasAccount")}{" "}
            </Text>
            <Link href="/(auth)/login" asChild>
              <TouchableOpacity>
                <Text style={[typography.h5, { color: colors.primary }]}>
                  {t("auth.register.login")}
                </Text>
              </TouchableOpacity>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24, justifyContent: "center" },
  header: { alignItems: "center", marginBottom: 32 },
  form: {},
  input: { height: 48, borderWidth: 1, fontSize: 14 },
  button: { alignItems: "center", justifyContent: "center" },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 24, marginBottom: 24 },
});

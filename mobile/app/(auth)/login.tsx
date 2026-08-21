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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { useAuthStore } from "@/hooks/useAuth";
import { useOAuth } from "@/hooks/useOAuth";
import { isAxiosError } from "axios";
import * as AppleAuthentication from "expo-apple-authentication";
import type { OAuthProvider } from "@/config/api";

/** Axios 에러 → 사용자 친화적 메시지 변환 */
function getLoginErrorMessage(err: unknown, t: (key: string) => string): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401) return t("auth.login.invalidCredentials");
    if (status === 404 || status === 502 || status === 503)
      return t("auth.login.serverUnavailable");
    if (!err.response) return t("auth.login.networkError");
  }
  return err instanceof Error ? err.message : t("common.error");
}

function getOAuthErrorMessage(err: unknown, t: (key: string) => string): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 404 || status === 502 || status === 503)
      return t("auth.login.oauthUnavailable");
    if (!err.response) return t("auth.login.networkError");
  }
  return err instanceof Error ? err.message : t("common.error");
}

export default function LoginScreen() {
  const { t } = useTranslation();
  const { colors, typography, spacing, radius } = useTheme();
  const login = useAuthStore((s) => s.login);
  const oauth = useOAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  function validate(): boolean {
    const next: typeof errors = {};
    if (!email.trim()) next.email = t("validation.emailRequired");
    else if (!/\S+@\S+\.\S+/.test(email)) next.email = t("validation.emailInvalid");
    if (!password) next.password = t("validation.passwordRequired");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleLogin() {
    if (!validate()) return;
    setIsLoading(true);
    try {
      await login(email.trim(), password);
      // AuthGate가 user 상태 변경 감지 후 자동으로 (tabs)로 라우팅
    } catch (err: unknown) {
      Alert.alert(t("auth.login.failed"), getLoginErrorMessage(err, t));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <View style={styles.content}>
          {/* 헤더 */}
          <View style={styles.header}>
            <Text style={[typography.h1, { color: colors.primary }]}>Pickket</Text>
            <Text style={[typography.body, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
              {t("auth.login.tagline")}
            </Text>
          </View>

          {/* 폼 */}
          <View style={[styles.form, { gap: spacing.lg }]}>
            {/* 이메일 */}
            <View>
              <Text style={[typography.h5, { color: colors.foreground, marginBottom: spacing.xs }]}>
                {t("auth.login.email")}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.secondary,
                    borderColor: errors.email ? colors.destructive : colors.border,
                    color: colors.foreground,
                    borderRadius: radius.md,
                    paddingHorizontal: spacing.lg,
                  },
                ]}
                testID="email-input"
                accessibilityLabel={t("auth.login.email")}
                placeholder={t("auth.login.placeholder")}
                placeholderTextColor={colors.mutedForeground}
                value={email}
                onChangeText={(v) => { setEmail(v); setErrors((p) => ({ ...p, email: undefined })); }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isLoading}
              />
              {errors.email && (
                <Text style={[typography.bodySmall, { color: colors.destructive, marginTop: spacing.xs }]}>
                  {errors.email}
                </Text>
              )}
            </View>

            {/* 비밀번호 */}
            <View>
              <Text style={[typography.h5, { color: colors.foreground, marginBottom: spacing.xs }]}>
                {t("auth.login.password")}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.secondary,
                    borderColor: errors.password ? colors.destructive : colors.border,
                    color: colors.foreground,
                    borderRadius: radius.md,
                    paddingHorizontal: spacing.lg,
                  },
                ]}
                testID="password-input"
                accessibilityLabel={t("auth.login.password")}
                placeholder="••••••••"
                placeholderTextColor={colors.mutedForeground}
                value={password}
                onChangeText={(v) => { setPassword(v); setErrors((p) => ({ ...p, password: undefined })); }}
                secureTextEntry
                editable={!isLoading}
              />
              {errors.password && (
                <Text style={[typography.bodySmall, { color: colors.destructive, marginTop: spacing.xs }]}>
                  {errors.password}
                </Text>
              )}
            </View>

            {/* 로그인 버튼 */}
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
              testID="login-button"
              accessibilityLabel={t("auth.login.submit")}
              accessibilityRole="button"
              onPress={handleLogin}
              disabled={isLoading}
              activeOpacity={0.8}
            >
              {isLoading ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[typography.h4, { color: colors.primaryForeground }]}>
                  {t("auth.login.submit")}
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {/* 소셜 로그인 */}
          <View style={[styles.social, { gap: spacing.sm }]}>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>{t("common.or")}</Text>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
          </View>

          <View style={{ gap: spacing.sm }}>
            {/* Apple Sign-In — iOS 전용 네이티브 버튼 (HIG 필수) */}
            {Platform.OS === "ios" && (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={9999}
                style={{ height: 48 }}
                onPress={async () => {
                  try {
                    await oauth.login("apple");
                  } catch (err: unknown) {
                    Alert.alert(t("auth.login.failed"), getOAuthErrorMessage(err, t));
                  }
                }}
              />
            )}
            {([
              { key: "kakao" as OAuthProvider, label: "Kakao" },
              { key: "google" as OAuthProvider, label: "Google" },
              { key: "naver" as OAuthProvider, label: "Naver" },
            ]).map((provider) => (
              <TouchableOpacity
                key={provider.key}
                style={[
                  styles.socialButton,
                  {
                    backgroundColor: colors.secondary,
                    borderRadius: radius.full,
                    borderColor: colors.border,
                    height: 48,
                    opacity: isLoading || oauth.isLoading ? 0.7 : 1,
                  },
                ]}
                testID={`oauth-${provider.key}-button`}
                accessibilityLabel={t(`auth.login.social${provider.label}`)}
                accessibilityRole="button"
                activeOpacity={0.8}
                disabled={isLoading || oauth.isLoading}
                onPress={async () => {
                  try {
                    await oauth.login(provider.key);
                  } catch (err: unknown) {
                    Alert.alert(t("auth.login.failed"), getOAuthErrorMessage(err, t));
                  }
                }}
              >
                {oauth.isLoading ? (
                  <ActivityIndicator color={colors.foreground} size="small" />
                ) : (
                  <Text style={[typography.h5, { color: colors.foreground }]}>
                    {t(`auth.login.social${provider.label}`)}
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </View>

          {/* 회원가입 링크 */}
          <View style={styles.footer}>
            <Text style={[typography.body, { color: colors.mutedForeground }]}>
              {t("auth.login.noAccount")}{" "}
            </Text>
            <Link href="/(auth)/register" asChild>
              <TouchableOpacity>
                <Text style={[typography.h5, { color: colors.primary }]}>
                  {t("auth.login.register")}
                </Text>
              </TouchableOpacity>
            </Link>
          </View>

          {/* 게스트 둘러보기 — Apple 심사 필수 */}
          <TouchableOpacity
            style={{ alignItems: "center", marginTop: spacing.lg }}
            testID="guest-browse-button"
            accessibilityLabel={t("auth.login.guestBrowse")}
            accessibilityRole="button"
            onPress={() => router.replace("/(tabs)")}
            activeOpacity={0.7}
          >
            <Text style={[typography.body, { color: colors.mutedForeground, textDecorationLine: "underline" }]}>
              {t("auth.login.guestBrowse")}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 24, justifyContent: "center" },
  header: { alignItems: "center", marginBottom: 40 },
  form: {},
  input: { height: 48, borderWidth: 1, fontSize: 14 },
  button: { alignItems: "center", justifyContent: "center" },
  social: { flexDirection: "row", alignItems: "center", marginVertical: 24 },
  divider: { flex: 1, height: 1 },
  socialButton: { alignItems: "center", justifyContent: "center", borderWidth: 1 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 24 },
});

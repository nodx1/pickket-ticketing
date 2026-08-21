import { useCallback } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "./useAuth";

/**
 * 인증 필요 액션 가드
 *
 * 게스트가 보호된 기능(예매, 즐겨찾기 등) 시도 시
 * Alert → 로그인 화면으로 이동
 *
 * @returns { isGuest, requireAuth } — requireAuth는 인증 시 true 반환
 */
export function useRequireAuth() {
  const { t } = useTranslation();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);

  const requireAuth = useCallback((): boolean => {
    if (user && !isGuest) return true;

    Alert.alert(
      t("auth.loginRequired"),
      t("auth.loginToContinue"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("auth.login.submit"),
          onPress: () => router.push("/(auth)/login"),
        },
      ],
    );
    return false;
  }, [user, isGuest, t, router]);

  return { isGuest: !user || isGuest, requireAuth };
}

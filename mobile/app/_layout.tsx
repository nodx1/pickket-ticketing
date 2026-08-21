import { useEffect, useState, useRef } from "react";
import { Alert, AppState, type AppStateStatus } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { AppProviders } from "@/providers/AppProviders";
import { useAuthStore } from "@/hooks/useAuth";
import { LoadingScreen } from "@/components/common/LoadingScreen";
import { getInitialDeepLink, addDeepLinkListener } from "@/lib/deep-linking";
import { flushAnalytics, initAnalyticsConsent, trackScreenView } from "@/lib/analytics";
import { checkAndAuthenticate } from "@/lib/biometric";
import { checkAppVersion, openStore } from "@/lib/version-check";
import { initCrashReporting, reportError } from "@/lib/crash-reporting";
import { checkPinExpiry } from "@/lib/ssl-pinning";
import { hydrateDeviceId } from "@/lib/device-id";
import { storage } from "@/lib/storage";
import i18n from "@/i18n";
import { useGeofenceForeground } from "@/hooks/useGeofence";
import { initPushResponseHandler } from "@/lib/push-response";

// 앱 모듈 로드 시 크래시 리포팅 초기화
initCrashReporting();
// AUDIT §13 P0: 디바이스 ID 부트 시 1회 생성/로드 → axios interceptor가 동기 접근
hydrateDeviceId().catch((e) => reportError(e, { scope: "deviceId.hydrate" }));

// 스플래시 자동 숨김 방지 — 앱 준비 완료 시 수동으로 숨김
SplashScreen.preventAutoHideAsync();

// 인증 필요 없는 route 그룹 (게스트 접근 가능)
const PUBLIC_GROUPS = new Set(["(tabs)", "(auth)", "event", "e", "discover", "vote", "quiz", "photocard", "trading", "league", "ocr"]);

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isGuest } = useAuthStore();
  const segments = useSegments();
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);
  const [loadingExiting, setLoadingExiting] = useState(false);
  const [loadingDone, setLoadingDone] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const pendingDeepLink = useRef<string | null>(null);

  // Phase E.1: 위치 기반 알림 포그라운드 체크 (opt-in 기반)
  useGeofenceForeground();

  // Phase G.2: 자동 화면 트래킹 (consent OFF 시 analytics.ts gating 자동 무시)
  useEffect(() => {
    if (!segments) return;
    const path = "/" + segments.join("/");
    if (path.length > 1) trackScreenView(path);
  }, [segments]);

  // 딥링크 리스너 (앱이 이미 열려있는 상태에서)
  useEffect(() => {
    const subscription = addDeepLinkListener((route) => {
      router.push(route as never);
    });
    return () => subscription.remove();
  }, [router]);

  // 초기 딥링크 처리 (앱이 딥링크로 열린 경우)
  useEffect(() => {
    getInitialDeepLink().then((route) => {
      if (route) pendingDeepLink.current = route;
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (isLoading) return;

    // 인증 상태 확인 완료 → 네이티브 스플래시 숨김 (JS LoadingScreen이 이어받음)
    SplashScreen.hideAsync();
    setIsReady(true);
    // 최소 800ms 보장 (로고 애니메이션 충분히 보이도록) 후 퇴장 시작
    setTimeout(() => setLoadingExiting(true), 800);

    const topSegment = segments[0] as string | undefined;
    const inAuthGroup = topSegment === "(auth)";
    const isAuthenticated = !!user && !isGuest;
    const isPublicRoute = !topSegment || PUBLIC_GROUPS.has(topSegment);

    // 로그아웃 시 consentChecked 를 리셋해야 다음 유저가 동의 체크를 건너뛰지 않는다(P2-C22).
    // 미리셋 시 같은 세션 내 재로그인에서 isAuthenticated&&consentChecked 로 consent 게이트가 스킵됨.
    if (!isAuthenticated && consentChecked) {
      setConsentChecked(false);
    }

    // AUDIT 2026-04-20 §1 P0: consent race 해결
    // 과거: storage.get().then(...) 비동기가 아래 router.replace("/(tabs)") 다음에 실행 →
    //       tabs 진입 후 consent가 덮어써서 화면 깜빡임 + focus 이탈
    // 해결: consent 체크가 끝나지 않았으면 라우팅 결정 자체를 뒤로 미룸
    if (isAuthenticated && !consentChecked) {
      storage
        .get("consent_accepted")
        .then((v) => {
          setConsentChecked(true);
          if (!v) router.replace("/(auth)/consent");
          else if (inAuthGroup) router.replace("/(tabs)");
        })
        .catch(() => {
          setConsentChecked(true);
          router.replace("/(auth)/consent");
        });
      return; // consent 결과 나올 때까지 나머지 라우팅 유보
    }

    if (isAuthenticated && inAuthGroup) {
      // 인증 완료 + auth 화면 → 홈으로
      router.replace("/(tabs)");
    } else if (!isAuthenticated && !isPublicRoute) {
      // 미인증 + 보호 route (ticket, order 등) → 로그인으로
      router.replace("/(auth)/login");
    }

    // 대기 중인 딥링크 처리
    if (pendingDeepLink.current) {
      const route = pendingDeepLink.current;
      const isProtectedRoute = !PUBLIC_GROUPS.has(route.split("/")[1] ?? "");

      if (isAuthenticated || !isProtectedRoute) {
        router.push(route as never);
      }
      pendingDeepLink.current = null;
    }
    // 게스트도 (tabs), event 접근 가능 (Apple 심사 필수)
  }, [user, isLoading, isGuest, segments, router]);

  if (!isReady) {
    return <LoadingScreen />;
  }

  return (
    <>
      {children}
      {!loadingDone && (
        <LoadingScreen
          exiting={loadingExiting}
          onExitComplete={() => setLoadingDone(true)}
        />
      )}
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    "Pretendard-Regular": require("../assets/fonts/Pretendard-Regular.otf"),
    "Pretendard-Medium": require("../assets/fonts/Pretendard-Medium.otf"),
    "Pretendard-SemiBold": require("../assets/fonts/Pretendard-SemiBold.otf"),
    "Pretendard-Bold": require("../assets/fonts/Pretendard-Bold.otf"),
    "Pretendard-ExtraBold": require("../assets/fonts/Pretendard-ExtraBold.otf"),
    "Pretendard-Black": require("../assets/fonts/Pretendard-Black.otf"),
  });
  const [isLocked, setIsLocked] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // 앱 시작 시 Analytics 동의 상태 로드
  useEffect(() => {
    initAnalyticsConsent().catch(() => {});
  }, []);

  // SSL 핀 만료 모니터링 — 60일 이내면 경고
  useEffect(() => {
    const { daysUntilExpiry, isWarning } = checkPinExpiry();
    if (isWarning) {
      if (__DEV__) console.warn(`[SSL Pinning] Certificate pins expire in ${daysUntilExpiry} days. Rotate pins before expiry.`);
      reportError(new Error(`SSL pins expire in ${daysUntilExpiry} days`), { context: "ssl-pin-expiry" });
    }
  }, []);

  // Phase E.3/E.4: 푸시 탭 응답 핸들러 등록
  useEffect(() => {
    const sub = initPushResponseHandler();
    return () => sub.remove();
  }, []);

  // 앱 시작 시 버전 체크
  useEffect(() => {
    checkAppVersion().then((result) => {
      const t = i18n.t.bind(i18n);
      if (result.status === "update_required") {
        setUpdateRequired(true);
        Alert.alert(
          t("common.updateRequired"),
          result.releaseNotes ?? t("common.updateRequiredMessage"),
          [{ text: t("common.update"), onPress: openStore }],
          { cancelable: false },
        );
      } else if (result.status === "update_recommended") {
        Alert.alert(
          t("common.updateRecommended"),
          result.releaseNotes ?? t("common.updateRecommendedMessage"),
          [
            { text: t("common.later"), style: "cancel" },
            { text: t("common.update"), onPress: openStore },
          ],
        );
      }
    }).catch(reportError);
  }, []);

  // 앱 포그라운드 복귀 시 생체 인증 + 분석 플러시
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      // 백그라운드/비활성 → 분석 버퍼 플러시
      if (nextState === "background" || nextState === "inactive") {
        flushAnalytics();
      }

      // 백그라운드 → 포그라운드: 생체 인증 체크
      // checkAndAuthenticate() 내부에서 isBiometricEnabled() + 5분 경과 여부를 확인하므로
      // 생체 비활성 시 항상 success: true 반환 → 잠금 우회 문제 없음
      if (appStateRef.current.match(/background/) && nextState === "active") {
        checkAndAuthenticate().then((result) => {
          if (!result.success) {
            setIsLocked(true);
          }
        }).catch(reportError);
      }

      appStateRef.current = nextState;
    });
    return () => subscription.remove();
  }, []);

  // 폰트 로딩 완료 대기
  if (!fontsLoaded) {
    return null;
  }

  // 강제 업데이트 필요 시 앱 사용 차단
  if (updateRequired) {
    return (
      <AppProviders>
        <StatusBar style="auto" />
        <LoadingScreen />
      </AppProviders>
    );
  }

  // 생체 인증 잠금 시 잠금 해제 화면
  if (isLocked) {
    return (
      <AppProviders>
        <StatusBar style="auto" />
        <BiometricLockScreen onUnlock={() => setIsLocked(false)} />
      </AppProviders>
    );
  }

  return (
    <AppProviders>
      <StatusBar style="auto" />
      <AuthGate>
        <Stack screenOptions={{ headerShown: true }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="event/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="ticket/[id]" />
          <Stack.Screen name="order/[id]" />
          <Stack.Screen name="orders/index" />
          <Stack.Screen name="notifications" />
          <Stack.Screen name="favorites/index" />
          <Stack.Screen name="settings/index" />
          <Stack.Screen name="settings/language" options={{ headerShown: true }} />
          <Stack.Screen name="settings/push-preferences" options={{ headerShown: true }} />
          <Stack.Screen name="legal/privacy" />
          <Stack.Screen name="legal/terms" />
          <Stack.Screen name="legal/refund-policy" />
        </Stack>
      </AuthGate>
    </AppProviders>
  );
}

/** 생체 인증 잠금 화면 */
function BiometricLockScreen({ onUnlock }: { onUnlock: () => void }) {
  const handleUnlock = async () => {
    try {
      const result = await checkAndAuthenticate();
      if (result.success) onUnlock();
    } catch (err: unknown) {
      reportError(err, { context: "BiometricLockScreen" });
    }
  };

  useEffect(() => {
    // 잠금 화면 표시 시 자동으로 인증 시도
    handleUnlock();
  }, []);

  return (
    <LoadingScreen />
  );
}

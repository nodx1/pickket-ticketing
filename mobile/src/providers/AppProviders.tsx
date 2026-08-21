import { QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { queryClient } from "@/config/queryClient";
import { AuthProvider } from "./AuthProvider";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { NetworkBanner } from "@/components/common/NetworkBanner";

/**
 * 래핑 순서 (바깥→안쪽):
 * 1. GestureHandlerRootView (AUDIT §7 P0 — Android bottom sheet 제스처)
 * 2. SafeAreaProvider (AUDIT §7 P0 — iPhone 15+ 탭바 홈 인디케이터)
 * 3. ErrorBoundary (크래시 → 복구 화면)
 * 4. QueryClientProvider (React Query)
 * 5. AuthProvider (세션 복원)
 * 6. NetworkBanner (오프라인 배너, Navigation 위)
 *
 * i18n은 app/_layout.tsx에서 import로 초기화
 * Theme은 useColorScheme 훅으로 처리 (Provider 불필요)
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <NetworkBanner />
              {children}
            </AuthProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

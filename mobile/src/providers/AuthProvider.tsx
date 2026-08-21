import { useEffect, useRef } from "react";
import { useAuthStore } from "@/hooks/useAuth";
import { registerForPushNotifications } from "@/lib/push";

/**
 * 앱 시작 시 SecureStore에서 토큰 복원 → 세션 검증
 * 로그인 완료 시 Expo Push Token 서버 등록
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const hydrate = useAuthStore((s) => s.hydrate);
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const pushRegistered = useRef(false);

  // 앱 시작 시 1회만 실행
  useEffect(() => {
    hydrate();
  }, []);

  // 로그인 완료 시 push 토큰 등록
  useEffect(() => {
    if (user && !isGuest && !pushRegistered.current) {
      pushRegistered.current = true;
      registerForPushNotifications().catch(() => {
        // push 등록 실패해도 앱 동작에 영향 없음
      });
    }
    if (!user || isGuest) {
      pushRegistered.current = false;
    }
  }, [user, isGuest]);

  return <>{children}</>;
}

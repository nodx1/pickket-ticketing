"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAuthStore } from "@pickket/store";
import api, { setLoginRedirectPolicy } from "@pickket/lib/api";
import { needsLoginRedirect } from "@/lib/login-redirect-policy";

// 세션 만료 때 공개 화면에서는 로그인으로 튕기지 않는다(login-redirect-policy.ts 참고).
setLoginRedirectPolicy(needsLoginRedirect);

interface AuthContextValue {
  /** true once the initial session check is done (success or fail) */
  ready: boolean;
}

const AuthContext = createContext<AuthContextValue>({ ready: false });

export function useAuthReady() {
  return useContext(AuthContext).ready;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const { user } = useAuthStore.getState();

    // 이미 스토어에 user가 있으면 (SPA 내비게이션) 바로 완료
    if (user) {
      setReady(true);
      return;
    }

    // pickket_logged_in 쿠키가 없으면 비로그인 → 바로 완료
    const hasSession = document.cookie.includes("pickket_logged_in=1");
    if (!hasSession) {
      setReady(true);
      return;
    }

    // 쿠키 기반 세션 복원: /users/me 호출
    api
      .get("/users/me")
      .then((res) => {
        if (res.data) {
          useAuthStore.getState().setAuth(res.data, "cookie");
        }
      })
      .catch(() => {
        // 401 등 실패 → 비로그인 상태 유지
      })
      .finally(() => setReady(true));
  }, []);

  return (
    <AuthContext.Provider value={{ ready }}>{children}</AuthContext.Provider>
  );
}

/**
 * Auth Store — Zustand
 *
 * v2의 useAuthStore와 동일한 인터페이스 유지.
 * 차이: 웹은 쿠키+메모리, 모바일은 SecureStore+메모리.
 */
import { create } from "zustand";
import { storage } from "@/lib/storage";
import { queryClient } from "@/config/queryClient";
import { unregisterPush } from "@/lib/push";
import { clearOfflineQrCache } from "@/lib/offline-tickets";
import { clearPreferences } from "@/lib/preference-memory";
import {
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  getCurrentUser,
  updateProfile as apiUpdateProfile,
  deleteAccount as apiDeleteAccount,
  setAuthStateResetter,
  type User,
  type UserUpdate,
} from "@/config/api";

/**
 * AUDIT 2026-04-20 §3 P0:
 * 로그아웃/탈퇴 시 React Query 캐시가 남아 있으면 다음 유저가 이전 유저의
 * /users/me, /orders/my, /tickets/my, /favorites, /points/balance 등 PII를 상속받음.
 * 푸시 토큰도 서버에서 해제하지 않으면 다음 유저에 잘못된 매핑 남음.
 */
async function clearAuthArtifacts() {
  // 1) 푸시 토큰 해제 (네트워크 호출이라 빠르게 실패 감수)
  try {
    const storedToken = await storage.get("expo_push_token");
    if (storedToken) await unregisterPush(storedToken);
  } catch {
    /* best-effort */
  }
  // 2) SecureStore / AsyncStorage 인증 정리
  await storage.clearAuth();
  // 2-b) 오프라인 QR 캐시 인덱스 삭제 — 미삭제 시 비암호 AsyncStorage 에 이전 유저의
  //      티켓 ID 목록이 평문 잔존(기기공유 PII 노출, P2-C20).
  try {
    await clearOfflineQrCache();
  } catch {
    /* best-effort */
  }
  // 2-c) 동의(consent) 상태 삭제 — PIPA 개인별 동의 요건상 다음 유저가 이전 유저 동의를
  //      상속하면 안 됨(P2-C22). 다음 로그인 시 동의 화면 재노출.
  await Promise.all([
    storage.remove("consent_accepted"),
    storage.remove("consent_accepted_at"),
    storage.remove("analytics_consent"),
  ]);
  // 2-d) 취향 메모리(preference-memory) 삭제 — 공유 기기에서 이전 유저의 검색어·가격대 등
  //      PII가 AI 검색 컨텍스트로 다음 유저에게 전송되는 것을 방지(P2-C9).
  try {
    await clearPreferences();
  } catch {
    /* best-effort */
  }
  // 3) React Query 캐시 전면 삭제 — 유저 간 캐시 오염 방지
  queryClient.clear();
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isGuest: boolean;

  /** SecureStore에서 토큰 복원 → /users/me 세션 검증 */
  hydrate: () => Promise<void>;

  /** 이메일 로그인 */
  login: (email: string, password: string) => Promise<void>;

  /** 이메일 회원가입 */
  register: (params: { email: string; password: string; name: string }) => Promise<void>;

  /** 로그아웃 */
  logout: () => Promise<void>;

  /** 유저 정보 갱신 */
  setUser: (user: User) => void;

  /** 프로필 수��� */
  updateProfile: (params: UserUpdate) => Promise<void>;

  /** 회원 탈퇴 */
  deleteAccount: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isGuest: true,

  hydrate: async () => {
    set({ isLoading: true });
    try {
      const token = await storage.getAccessToken();
      if (!token) {
        set({ user: null, isGuest: true, isLoading: false });
        return;
      }

      // JWT 만료 로컬 체크 — 만료된 토큰으로 불필요한 API 호출 방지
      try {
        const parts = token.split(".");
        if (parts.length !== 3) throw new Error("Invalid JWT");
        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const { Buffer } = require("buffer");
        const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          await storage.clearAuth();
          set({ user: null, isGuest: true, isLoading: false });
          return;
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
        /* JWT 포맷이 아닌 경우 서버 검증으로 진행 */
      }

      // 토큰 유효성 검증 — 서버에서 확인
      const user = await getCurrentUser();
      set({ user, isGuest: false, isLoading: false });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
      // 토큰 만료/무효 → 정리
      await storage.clearAuth();
      set({ user: null, isGuest: true, isLoading: false });
    }
  },

  login: async (email, password) => {
    const data = await apiLogin(email, password);
    if (!data.access_token) throw new Error("Invalid token response");
    await storage.clearAuth();
    await storage.setAccessToken(data.access_token);
    if (data.refresh_token) {
      await storage.setRefreshToken(data.refresh_token);
    }
    set({ user: data.user, isGuest: false });
  },

  register: async (params) => {
    const data = await apiRegister(params);
    if (!data.access_token) throw new Error("Invalid token response");
    await storage.clearAuth();
    await storage.setAccessToken(data.access_token);
    if (data.refresh_token) {
      await storage.setRefreshToken(data.refresh_token);
    }
    set({ user: data.user, isGuest: false });
  },

  logout: async () => {
    try {
      await apiLogout();
    } finally {
      await clearAuthArtifacts();
      set({ user: null, isGuest: true });
    }
  },

  setUser: (user) => set({ user }),

  updateProfile: async (params) => {
    const updated = await apiUpdateProfile(params);
    set({ user: updated });
  },

  deleteAccount: async () => {
    // API 실패 시 로컬 정리하지 않음 (활성 티켓 등으로 탈퇴 거절될 수 있음)
    await apiDeleteAccount();
    await clearAuthArtifacts();
    set({ user: null, isGuest: true });
  },
}));

// API 인터셉터 → auth store 연결 (refresh 실패 시 로그아웃 + 캐시 정리)
// clearAuthArtifacts()를 호출해 push 토큰 서버 해제 + 오프라인 QR 캐시 + 취향 메모리 삭제.
// 미호출 시: 이전 사용자에게 타인 push 알림 전송, 오프라인 QR 위조 가능(P2-C7/C8/C9).
setAuthStateResetter(() => {
  void clearAuthArtifacts().catch(() => { /* best-effort */ });
  useAuthStore.setState({ user: null, isGuest: true });
});

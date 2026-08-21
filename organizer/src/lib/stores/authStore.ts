"use client";

import { create } from "zustand";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import type { User } from "@/lib/types";

interface LoginPayload {
  email: string;
  password: string;
}

interface AuthStore {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (payload: LoginPayload) => Promise<void>;
  logout: () => Promise<void>;
  fetchMe: () => Promise<void>;
  setUser: (user: User | null) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,
  async login(payload) {
    set({ isLoading: true });
    try {
      const result = await fetchWithAuth<{ data: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      set({
        user: result.data,
        isAuthenticated: true,
        isLoading: false,
      });

      /**
       * 🔴 로그인 응답의 `role` 은 신뢰하지 않는다 (2026-07-31 팀원 복구).
       *
       * 로그인 라우트는 v2 로그인 결과만 보고 응답을 만든다 — 조직 멤버십을 모른다.
       * 실제 역할은 **세션 해석**(verify-token → 멤버십)에서만 나온다.
       * 그대로 두면 팀원이 로그인 직후 `owner` 로 표시돼 화면이 오판한다
       * (`members-client.tsx:50 isOwner`).
       *
       * ⟹ 세션에서 다시 읽어 덮어쓴다. 실패해도 로그인 자체는 유지한다
       *    (여기서 로그아웃시키면 되던 로그인이 깨진다).
       */
      try {
        const me = await fetchWithAuth<{ data: User }>("/api/auth/me");
        set({ user: me.data });
      } catch {
        // 세션 조회 실패는 다음 화면 진입의 fetchMe 가 다시 시도한다.
      }
    } catch (err: unknown) {
      set({ isLoading: false });
      if (err instanceof Error) {
        throw err;
      }
      throw new Error("로그인에 실패했습니다");
    }
  },
  async logout() {
    set({ isLoading: true });
    try {
      await fetchWithAuth("/api/auth/logout", {
        method: "POST",
      });
    } finally {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },
  async fetchMe() {
    set({ isLoading: true });
    try {
      const result = await fetchWithAuth<{ data: User }>("/api/auth/me");
      set({
        user: result.data,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },
  setUser(user) {
    set({
      user,
      isAuthenticated: Boolean(user),
    });
  },
}));

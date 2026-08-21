import { create } from "zustand";
import { useEffect } from "react";

interface SidebarState {
  isCollapsed: boolean;
  hydrated: boolean;
  toggle: () => void;
  setCollapsed: (value: boolean) => void;
  hydrate: () => void;
}

const STORAGE_KEY = "pickket:sidebar-collapsed";

export const useSidebarStore = create<SidebarState>((set) => ({
  isCollapsed: false, // 서버 = 클라이언트 초기값 일치 → hydration 에러 방지
  hydrated: false,
  toggle: () =>
    set((state) => {
      const next = !state.isCollapsed;
      window.localStorage.setItem(STORAGE_KEY, String(next));
      return { isCollapsed: next };
    }),
  setCollapsed: (value) => {
    window.localStorage.setItem(STORAGE_KEY, String(value));
    set({ isCollapsed: value });
  },
  hydrate: () => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY) === "true";
    set({ isCollapsed: stored, hydrated: true });
  },
}));

/** 컴포넌트에서 사용: hydration 후 localStorage 반영 */
export function useSidebarHydration() {
  const hydrate = useSidebarStore((s) => s.hydrate);
  const hydrated = useSidebarStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrate, hydrated]);
}

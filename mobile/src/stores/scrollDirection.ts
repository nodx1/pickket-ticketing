import { create } from "zustand";

interface ScrollDirectionState {
  direction: "up" | "down" | "idle";
  lastY: number;
  /** setScrollY를 무시하는 기간 (탭 전환/초기 로드 시 활성) */
  frozen: boolean;
  setScrollY: (y: number) => void;
  /** 탭 전환 시 호출 — 탭바 강제 노출 + 일시 동결 */
  resetDirection: () => void;
}

export const useScrollDirection = create<ScrollDirectionState>((set, get) => ({
  direction: "idle",
  lastY: 0,
  frozen: false,
  setScrollY: (y: number) => {
    const { lastY, frozen } = get();
    if (frozen) return;
    const diff = y - lastY;
    if (Math.abs(diff) < 5) return;
    set({
      direction: diff > 0 ? "down" : "up",
      lastY: y,
    });
  },
  resetDirection: () => {
    set({ direction: "idle", lastY: 0, frozen: true });
    setTimeout(() => {
      set({ frozen: false });
    }, 1000);
  },
}));

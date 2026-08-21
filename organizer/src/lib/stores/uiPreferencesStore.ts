"use client";

import { create } from "zustand";
import { DEFAULT_COLLAPSED_GROUP_IDS } from "@/components/layout/event-sidebar-groups";

const STORAGE_KEY = "pickket-ui-prefs";

/**
 * 저장 포맷 버전.
 *
 * v1(무버전) 은 접힘 상태를 **그룹 라벨 문자열**로 저장했다("이벤트 준비", "추가 도구" …).
 * 2026-07-29 IA 재편으로 라벨이 전부 바뀌면서 그 키들은 어떤 그룹과도 매칭되지 않는
 * 고아가 된다(무한 잔류). v2 부터는 라벨과 분리된 **안정 id**(prepare/sell/…)로 저장한다.
 *
 * 마이그레이션은 하지 않는다 — 그룹이 병합·분할돼 옛 라벨과 새 id 사이에 1:1 대응이
 * 없기 때문이다. 대신 버전 불일치 시 `collapsedGroups` 를 1회 리셋한다.
 *
 * ⚠️ 2026-08-01 「자주 사용」 제거로 `itemUsageCount` 가 사라졌지만 **버전은 올리지 않는다.**
 *    올리면 전 사용자의 접힘 상태가 리셋된다. 사라진 키는 안 읽으면 그만이고,
 *    다음 저장 때 자연히 없어진다.
 */
const STORAGE_VERSION = 2;

interface UIPreferencesState {
  collapsedGroups: Set<string>;
  _hydrated: boolean;
  hydrate: () => void;
  /** @param groupId 그룹의 안정 id (라벨 아님) */
  toggleGroup: (groupId: string) => void;
}

interface StoredPrefs {
  collapsedGroups: string[];
}

/** 저장소에서 복원. 버전이 다르거나 없으면 접힘을 기본값으로 되돌린다. */
export function readStoredPrefs(raw: string | null): StoredPrefs {
  const fallback: StoredPrefs = { collapsedGroups: [...DEFAULT_COLLAPSED_GROUP_IDS] };
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as { v?: number; collapsedGroups?: string[] };

    if (parsed.v !== STORAGE_VERSION) {
      // 구버전(라벨 키) — 접힘 리셋. 옛 `itemUsageCount` 키가 남아 있어도 그냥 무시된다.
      return fallback;
    }

    return { collapsedGroups: parsed.collapsedGroups ?? [...DEFAULT_COLLAPSED_GROUP_IDS] };
  } catch {
    return fallback;
  }
}

export function serializePrefs(collapsedGroups: Set<string>): string {
  return JSON.stringify({
    v: STORAGE_VERSION,
    collapsedGroups: Array.from(collapsedGroups),
  });
}

function loadFromStorage(): StoredPrefs {
  if (typeof window === "undefined") {
    return { collapsedGroups: [...DEFAULT_COLLAPSED_GROUP_IDS] };
  }
  try {
    return readStoredPrefs(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { collapsedGroups: [...DEFAULT_COLLAPSED_GROUP_IDS] };
  }
}

function saveToStorage(collapsedGroups: Set<string>) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, serializePrefs(collapsedGroups));
  } catch {
    // 저장 실패(사파리 프라이빗 등)는 UI 동작을 막지 않는다 — 세션 내 상태는 유지된다.
  }
}

export const useUIPreferences = create<UIPreferencesState>((set) => ({
  // SSR/최초 렌더 기본값. 실제 사용자 설정은 hydrate() 가 덮어쓴다.
  collapsedGroups: new Set<string>(DEFAULT_COLLAPSED_GROUP_IDS),
  _hydrated: false,
  hydrate() {
    set((state) => {
      if (state._hydrated) return state;
      const stored = loadFromStorage();
      return { collapsedGroups: new Set(stored.collapsedGroups), _hydrated: true };
    });
  },
  toggleGroup(groupId) {
    set((state) => {
      const nextGroups = new Set(state.collapsedGroups);
      if (nextGroups.has(groupId)) {
        nextGroups.delete(groupId);
      } else {
        nextGroups.add(groupId);
      }
      saveToStorage(nextGroups);
      return { collapsedGroups: nextGroups };
    });
  },
}));

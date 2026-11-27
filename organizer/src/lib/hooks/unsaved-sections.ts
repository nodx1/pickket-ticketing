"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useUnsavedChanges } from "./useUnsavedChanges";

/**
 * 저장 버튼이 여러 개인 화면(이벤트 설정)에서 저장 안 된 구획을 한곳에 모은다.
 *
 * 구획마다 useUnsavedChanges 를 따로 부르면 두 구획이 미저장일 때 링크를 누르는 순간
 * 확인창이 두 번 뜬다. 그래서 구획은 useUnsavedSection 으로 「고쳤다/저장했다」만 알리고,
 * 화면에 하나만 두는 UnsavedSectionsGuard 가 한 번만 묻는다. 확인 문구에는 어느 구획이
 * 저장되지 않았는지 이름을 넣는다.
 */

const sections = new Map<string, string>(); // key → 구획 이름(화면에 보이는 이름). 넣은 순서를 지킨다.
const listeners = new Set<() => void>();
const EMPTY: readonly string[] = [];
let snapshot: readonly string[] = EMPTY;

function emit() {
  snapshot = sections.size ? [...sections.values()] : EMPTY;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 지금 저장 안 된 구획 이름들. */
export function getUnsavedSectionLabels(): readonly string[] {
  return snapshot;
}

/** 구획 하나의 미저장 여부를 알린다. 화면에서 빠지면(언마운트) 목록에서도 빠진다. */
export function useUnsavedSection(key: string, label: string, dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    sections.set(key, label);
    emit();
    return () => {
      if (sections.delete(key)) emit();
    };
  }, [key, label, dirty]);
}

/** 저장 안 된 구획 이름 목록을 구독한다. */
export function useUnsavedSectionLabels(): readonly string[] {
  return useSyncExternalStore(subscribe, getUnsavedSectionLabels, () => EMPTY);
}

export function unsavedSectionsMessage(labels: readonly string[]) {
  return `저장하지 않은 변경이 있어요(${labels.join(", ")}). 이 화면을 떠날까요?`;
}

/** 화면에 하나만 둔다. 저장 안 된 구획이 있으면 탭 닫기·새로고침·링크 이동 때 한 번 묻는다. */
export function UnsavedSectionsGuard(): null {
  const labels = useUnsavedSectionLabels();
  useUnsavedChanges(labels.length > 0, unsavedSectionsMessage(labels));
  return null;
}

/** 테스트 전용 — 모듈 상태를 비운다. */
export function __resetUnsavedSectionsForTest() {
  sections.clear();
  emit();
}

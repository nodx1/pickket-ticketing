"use client";

import { create } from "zustand";

/* ─── Types ─── */

export interface TutorialState {
  /* persisted (localStorage) */
  completedTours: string[];
  dismissedCoachmarks: string[];
  skippedTours: string[];

  /* session */
  activeTourId: string | null;
  activeStepIndex: number;
  isPaused: boolean;

  /* actions */
  startTour: (tourId: string) => void;
  nextStep: () => void;
  prevStep: () => void;
  skipTour: () => void;
  completeTour: () => void;
  pauseTour: () => void;
  resumeTour: () => void;
  dismissCoachmark: (featureId: string) => void;
  resetAll: () => void;

  /* helpers */
  isTourCompleted: (tourId: string) => boolean;
  isTourSkipped: (tourId: string) => boolean;
  isCoachmarkDismissed: (featureId: string) => boolean;
  shouldShowWelcome: () => boolean;
}

/* ─── localStorage helpers ─── */

const STORAGE_KEY = "pickket-tutorial";

interface PersistedData {
  completedTours: string[];
  dismissedCoachmarks: string[];
  skippedTours: string[];
}

function loadPersisted(): PersistedData {
  if (typeof window === "undefined") {
    return { completedTours: [], dismissedCoachmarks: [], skippedTours: [] };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { completedTours: [], dismissedCoachmarks: [], skippedTours: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedData>;
    return {
      completedTours: parsed.completedTours ?? [],
      dismissedCoachmarks: parsed.dismissedCoachmarks ?? [],
      skippedTours: parsed.skippedTours ?? [],
    };
  } catch {
    return { completedTours: [], dismissedCoachmarks: [], skippedTours: [] };
  }
}

function savePersisted(data: PersistedData) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/* ─── Store ─── */

const initial = loadPersisted();

export const useTutorialStore = create<TutorialState>((set, get) => ({
  completedTours: initial.completedTours,
  dismissedCoachmarks: initial.dismissedCoachmarks,
  skippedTours: initial.skippedTours,

  activeTourId: null,
  activeStepIndex: 0,
  isPaused: false,

  startTour(tourId) {
    const state = get();
    if (state.activeTourId) return;
    if (state.completedTours.includes(tourId)) return;
    if (state.skippedTours.includes(tourId)) return;
    set({ activeTourId: tourId, activeStepIndex: 0, isPaused: false });
  },

  nextStep() {
    set((s) => ({ activeStepIndex: s.activeStepIndex + 1 }));
  },

  prevStep() {
    set((s) => ({ activeStepIndex: Math.max(0, s.activeStepIndex - 1) }));
  },

  skipTour() {
    const state = get();
    if (!state.activeTourId) return;
    const next = [...state.skippedTours, state.activeTourId];
    savePersisted({
      completedTours: state.completedTours,
      dismissedCoachmarks: state.dismissedCoachmarks,
      skippedTours: next,
    });
    set({ activeTourId: null, activeStepIndex: 0, isPaused: false, skippedTours: next });
  },

  completeTour() {
    const state = get();
    if (!state.activeTourId) return;
    const next = [...state.completedTours, state.activeTourId];
    savePersisted({
      completedTours: next,
      dismissedCoachmarks: state.dismissedCoachmarks,
      skippedTours: state.skippedTours,
    });
    set({ activeTourId: null, activeStepIndex: 0, isPaused: false, completedTours: next });
  },

  pauseTour() {
    set({ isPaused: true });
  },

  resumeTour() {
    set({ isPaused: false });
  },

  dismissCoachmark(featureId) {
    const state = get();
    if (state.dismissedCoachmarks.includes(featureId)) return;
    const next = [...state.dismissedCoachmarks, featureId];
    savePersisted({
      completedTours: state.completedTours,
      dismissedCoachmarks: next,
      skippedTours: state.skippedTours,
    });
    set({ dismissedCoachmarks: next });
  },

  resetAll() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    set({
      completedTours: [],
      dismissedCoachmarks: [],
      skippedTours: [],
      activeTourId: null,
      activeStepIndex: 0,
      isPaused: false,
    });
  },

  isTourCompleted: (tourId) => get().completedTours.includes(tourId),
  isTourSkipped: (tourId) => get().skippedTours.includes(tourId),
  isCoachmarkDismissed: (featureId) => get().dismissedCoachmarks.includes(featureId),

  shouldShowWelcome() {
    const state = get();
    return (
      !state.completedTours.includes("welcome") &&
      !state.skippedTours.includes("welcome") &&
      state.activeTourId === null
    );
  },
}));

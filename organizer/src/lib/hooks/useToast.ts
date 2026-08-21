"use client";

import { create } from "zustand";

export type ToastVariant = "success" | "error" | "warning";

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, "id">) => void;
  removeToast: (id: string) => void;
}

const toastDurations: Record<ToastVariant, number> = {
  success: 3000,
  error: 5000,
  warning: 5000,
};

const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id }],
    }));

    window.setTimeout(() => {
      useToastStore.getState().removeToast(id);
    }, toastDurations[toast.variant]);
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
}));

export function useToast() {
  return useToastStore();
}

export function showSuccess(message: string) {
  useToastStore.getState().addToast({ message, variant: "success" });
}

export function showError(message: string) {
  useToastStore.getState().addToast({ message, variant: "error" });
}

export function showWarning(message: string) {
  useToastStore.getState().addToast({ message, variant: "warning" });
}

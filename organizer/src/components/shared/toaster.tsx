"use client";

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { useToast } from "@/lib/hooks/useToast";

export function Toaster() {
  const { toasts, removeToast } = useToast();

  return (
    <ToastProvider>
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          variant={toast.variant === "success" ? "success" : "warning"}
          className="data-[state=open]:animate-in data-[state=open]:slide-in-from-right-6 data-[state=closed]:animate-out data-[state=closed]:fade-out-80"
          onOpenChange={(open) => {
            if (!open) {
              removeToast(toast.id);
            }
          }}
        >
          <div className="space-y-1">
            <ToastTitle>{toast.variant === "success" ? "완료" : toast.variant === "error" ? "오류" : "안내"}</ToastTitle>
            <ToastDescription>{toast.message}</ToastDescription>
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport className="fixed right-4 top-4 z-50" />
    </ToastProvider>
  );
}

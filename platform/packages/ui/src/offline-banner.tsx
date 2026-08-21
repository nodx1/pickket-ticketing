"use client";

import { useNetworkStatus } from "@pickket/lib/hooks";
import { WifiOff } from "lucide-react";

export function OfflineBanner() {
  const { isOnline } = useNetworkStatus();

  if (isOnline) return null;

  return (
    <div
      role="alert"
      className="fixed top-0 inset-x-0 z-[100] flex items-center justify-center gap-2 bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>인터넷 연결이 끊어졌습니다</span>
    </div>
  );
}

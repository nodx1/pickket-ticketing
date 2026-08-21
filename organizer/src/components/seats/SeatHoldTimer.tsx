"use client";

/**
 * SeatHoldTimer — 좌석 홀드 잔여 시간 카운트다운 (Phase 6 포팅)
 *
 * v2 SeatHoldTimer.tsx를 GO 톤(라이트모드)으로 포팅.
 * `sonner` 대신 `@/lib/hooks/useToast`의 showError 사용.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { showError, showWarning } from "@/lib/hooks/useToast";

interface SeatHoldTimerProps {
  holdExpiresAt: string;
  onExpire: () => void;
  /** 만료 30초 전 경고 (Phase 1.4) */
  warnBeforeSec?: number;
  /** sticky 위치 (모바일=bottom, 데스크탑=top) */
  sticky?: boolean;
  className?: string;
}

function calcRemaining(target: string) {
  const diff = new Date(target).getTime() - Date.now();
  if (Number.isNaN(diff) || diff <= 0) {
    return { minutes: 0, seconds: 0, expired: true, totalSeconds: 0 };
  }
  const totalSeconds = Math.floor(diff / 1000);
  return {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
    expired: false,
    totalSeconds,
  };
}

export function SeatHoldTimer({
  holdExpiresAt,
  onExpire,
  warnBeforeSec = 30,
  sticky = false,
  className,
}: SeatHoldTimerProps) {
  const [remaining, setRemaining] = useState(() => calcRemaining(holdExpiresAt));
  const [hasExpired, setHasExpired] = useState(false);
  const warnedRef = useRef(false);

  const handleExpire = useCallback(() => {
    if (hasExpired) return;
    setHasExpired(true);
    showError("좌석 홀드가 만료되었습니다. 다시 선택해주세요.");
    onExpire();
  }, [hasExpired, onExpire]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const next = calcRemaining(holdExpiresAt);
      setRemaining(next);
      // 만료 N초 전 경고 (Phase 1.4) — 1회만
      if (
        !warnedRef.current &&
        !next.expired &&
        next.totalSeconds <= warnBeforeSec
      ) {
        warnedRef.current = true;
        showWarning(`좌석 홀드 만료 ${next.totalSeconds}초 전입니다. 빨리 결제해주세요.`);
        if (typeof navigator !== "undefined" && "vibrate" in navigator) {
          try {
            navigator.vibrate(200);
          } catch {
            /* iOS 거부 시 무시 */
          }
        }
      }
      if (next.expired) {
        window.clearInterval(interval);
        handleExpire();
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [holdExpiresAt, handleExpire, warnBeforeSec]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        const next = calcRemaining(holdExpiresAt);
        setRemaining(next);
        if (next.expired) handleExpire();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [holdExpiresAt, handleExpire]);

  if (remaining.expired) return null;

  const isUrgent = remaining.totalSeconds < 180;
  const pad = (n: number) => n.toString().padStart(2, "0");

  return (
    <div
      role="timer"
      aria-live="polite"
      aria-label={`좌석 홀드 잔여 시간 ${remaining.minutes}분 ${remaining.seconds}초`}
      className={cn(
        "flex items-center gap-2 rounded-xl p-2.5 text-sm shadow-sm",
        isUrgent
          ? "animate-pulse bg-destructive text-destructive"
          : "bg-warning text-warning",
        sticky &&
          "sticky bottom-2 z-20 mx-auto w-fit border border-border/50 backdrop-blur lg:bottom-auto lg:top-2",
        className,
      )}
    >
      {isUrgent ? (
        <AlertTriangle className="h-4 w-4 shrink-0" />
      ) : (
        <Clock className="h-4 w-4 shrink-0" />
      )}
      <span className="font-medium">
        좌석 홀드: {pad(remaining.minutes)}:{pad(remaining.seconds)}
      </span>
    </div>
  );
}

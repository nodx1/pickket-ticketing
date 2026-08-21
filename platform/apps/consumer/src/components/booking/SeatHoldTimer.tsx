"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Clock, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@pickket/lib";
import { useTranslations } from "next-intl";

interface SeatHoldTimerProps {
  holdExpiresAt: string;
  onExpire: () => void;
}

function calcRemaining(target: string) {
  const diff = new Date(target).getTime() - Date.now();
  if (diff <= 0) return { minutes: 0, seconds: 0, expired: true, totalSeconds: 0 };
  const totalSeconds = Math.floor(diff / 1000);
  return {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
    expired: false,
    totalSeconds,
  };
}

export default function SeatHoldTimer({ holdExpiresAt, onExpire }: SeatHoldTimerProps) {
  const t = useTranslations("booking.seatHoldTimer");
  const [remaining, setRemaining] = useState(() => calcRemaining(holdExpiresAt));
  const [hasExpired, setHasExpired] = useState(false);

  /**
   * `t` 를 콜백 안에서 부르지 않고 **렌더 시점에 문자열로 뽑아** deps 에 넣는다.
   *
   * `handleExpire` 는 아래 `useEffect` 의 deps 다(1초 카운트다운 interval).
   * React Compiler 는 `t` 를 deps 에 넣으라고 요구하는데, 그러면 콜백 참조가
   * **무엇을 기준으로 바뀌는지**가 t 의 안정성에 달린다:
   *
   * ```
   * 진짜 next-intl 4.8.3   t 는 안정 참조   → 프로덕션은 안전
   * 테스트 전역 목          매번 새 함수     → 테스트에서만 interval 이 매 렌더 재생성
   * ```
   * (둘 다 실측: `src/lib/__tests__/use-translations-{stability,mock-instability}.test.tsx`)
   *
   * 문자열로 뽑으면 양쪽 다 안전하다 — 값 비교라 같은 언어에서는 안 바뀌고
   * 언어를 바꾸면 그때만 바뀐다. 좌석 홀드 만료가 걸린 자리라 환경에 안 기대는 쪽을 쓴다.
   */
  const expiredMessage = t("expired");
  const handleExpire = useCallback(() => {
    if (!hasExpired) {
      setHasExpired(true);
      toast.error(expiredMessage);
      onExpire();
    }
  }, [hasExpired, onExpire, expiredMessage]);

  useEffect(() => {
    const interval = setInterval(() => {
      const next = calcRemaining(holdExpiresAt);
      setRemaining(next);
      if (next.expired) {
        clearInterval(interval);
        handleExpire();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [holdExpiresAt, handleExpire]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const next = calcRemaining(holdExpiresAt);
        setRemaining(next);
        if (next.expired) handleExpire();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [holdExpiresAt, handleExpire]);

  if (remaining.expired) return null;

  const isUrgent = remaining.totalSeconds < 180;
  const pad = (n: number) => n.toString().padStart(2, "0");

  return (
    <div
      className={cn(
        "rounded-xl p-2.5 flex items-center gap-2 text-sm",
        isUrgent
          ? "bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400 animate-pulse"
          : "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
      )}
    >
      {isUrgent ? (
        <AlertTriangle className="h-4 w-4 shrink-0" />
      ) : (
        <Clock className="h-4 w-4 shrink-0" />
      )}
      <span className="font-medium">
        {t("holdLabel", { minutes: pad(remaining.minutes), seconds: pad(remaining.seconds) })}
      </span>
    </div>
  );
}

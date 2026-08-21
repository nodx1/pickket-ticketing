"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface DeadlineState {
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
  isUrgent: boolean;   // < 1 hour
  isCritical: boolean; // < 10 minutes
  display: string;     // "23:59:59" or "만료됨"
  totalSeconds: number;
}

function calcState(deadlineMs: number): DeadlineState {
  const diff = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
  const expired = diff <= 0;
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  const display = expired
    ? "만료됨"
    : hours > 0
      ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`;

  return {
    hours,
    minutes,
    seconds,
    expired,
    isUrgent: !expired && diff < 3600,
    isCritical: !expired && diff < 600,
    display,
    totalSeconds: diff,
  };
}

export function usePaymentDeadline(
  deadlineIso: string | null | undefined,
  onExpire?: () => void,
): DeadlineState {
  const deadlineMs = deadlineIso ? new Date(deadlineIso).getTime() : 0;
  const [state, setState] = useState<DeadlineState>(() =>
    deadlineMs ? calcState(deadlineMs) : { hours: 0, minutes: 0, seconds: 0, expired: true, isUrgent: false, isCritical: false, display: "만료됨", totalSeconds: 0 },
  );
  const expiredRef = useRef(false);
  const onExpireRef = useRef(onExpire);

  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  const tick = useCallback(() => {
    if (!deadlineMs) return;
    const next = calcState(deadlineMs);
    setState(next);
    if (next.expired && !expiredRef.current) {
      expiredRef.current = true;
      onExpireRef.current?.();
    }
  }, [deadlineMs]);

  useEffect(() => {
    if (!deadlineMs) return;
    expiredRef.current = false;
    tick();
    const id = setInterval(tick, 1000);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [deadlineMs, tick]);

  return state;
}

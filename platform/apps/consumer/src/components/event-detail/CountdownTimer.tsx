"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Clock } from "lucide-react";

interface CountdownTimerProps {
  targetDate: string;
  label?: string;
  onExpire?: () => void;
  compact?: boolean;
  compactClassName?: string;
}

interface TimeRemaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

function calcRemaining(target: string): TimeRemaining {
  const diff = new Date(target).getTime() - Date.now();

  if (diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  }

  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
    expired: false,
  };
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function Digit({ value }: { value: string }) {
  return (
    <span
      className="inline-block transition-transform duration-300 font-tabular font-bold"
      key={value}
    >
      {value}
    </span>
  );
}

export default function CountdownTimer({
  targetDate,
  label,
  onExpire,
  compact = false,
  compactClassName,
}: CountdownTimerProps) {
  const t = useTranslations("event.countdownTimer");
  const [remaining, setRemaining] = useState<TimeRemaining>({
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
    expired: false,
  });
  const [hasExpired, setHasExpired] = useState(false);

  const handleExpire = useCallback(() => {
    if (!hasExpired) {
      setHasExpired(true);
      onExpire?.();
    }
  }, [hasExpired, onExpire]);

  // Compute initial value on mount to avoid SSR/client mismatch
  useEffect(() => {
    setRemaining(calcRemaining(targetDate));
  }, [targetDate]);

  useEffect(() => {
    const interval = setInterval(() => {
      const next = calcRemaining(targetDate);
      setRemaining(next);

      if (next.expired) {
        clearInterval(interval);
        handleExpire();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [targetDate, handleExpire]);

  // Recalculate immediately when tab becomes visible (intervals throttled in background)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        const next = calcRemaining(targetDate);
        setRemaining(next);
        if (next.expired) handleExpire();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [targetDate, handleExpire]);

  // Calculate total remaining hours for urgency check
  const totalHours =
    remaining.days * 24 + remaining.hours;
  const isUrgent = !remaining.expired && totalHours < 1;

  if (remaining.expired) {
    if (compact) {
      return (
        <span className="text-sm font-semibold text-muted-foreground">
          {t("expired")}
        </span>
      );
    }

    return (
      <div className="bg-surface-dim rounded-2xl p-3 flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-muted-foreground">
          {t("expired")}
        </span>
      </div>
    );
  }

  const hoursStr = pad(remaining.hours);
  const minutesStr = pad(remaining.minutes);
  const secondsStr = pad(remaining.seconds);

  if (compact) {
    const display =
      remaining.days > 0
        ? `${remaining.days}일 ${hoursStr}:${minutesStr}:${secondsStr}`
        : `${hoursStr}:${minutesStr}:${secondsStr}`;

    return (
      <span
        className={
          compactClassName ??
          `text-sm font-tabular font-bold ${
            isUrgent ? "text-red-500 animate-pulse motion-reduce:animate-none" : "text-primary"
          }`
        }
      >
        {display}
      </span>
    );
  }

  return (
    <div className="bg-surface-dim rounded-2xl p-3 flex items-center gap-3">
      <Clock
        className={`h-4 w-4 shrink-0 ${
          isUrgent ? "text-red-500" : "text-primary"
        }`}
      />

      {label && (
        <span className="text-xs text-muted-foreground shrink-0">
          {label}
        </span>
      )}

      <div
        className={`flex items-center gap-0.5 text-lg ${
          isUrgent ? "text-red-500 animate-pulse motion-reduce:animate-none" : "text-primary"
        }`}
      >
        {remaining.days > 0 && (
          <>
            <Digit value={remaining.days.toString()} />
            <span className="text-xs text-muted-foreground mx-1">{t("dayUnit")}</span>
          </>
        )}

        <Digit value={hoursStr[0]} />
        <Digit value={hoursStr[1]} />
        <span className="mx-0.5 font-bold">:</span>
        <Digit value={minutesStr[0]} />
        <Digit value={minutesStr[1]} />
        <span className="mx-0.5 font-bold">:</span>
        <Digit value={secondsStr[0]} />
        <Digit value={secondsStr[1]} />
      </div>
    </div>
  );
}

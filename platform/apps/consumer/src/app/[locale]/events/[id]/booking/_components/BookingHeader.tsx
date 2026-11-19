"use client";

import { useState, useEffect, useRef } from "react";
import { Calendar, MapPin, Clock, ChevronLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@pickket/lib";
import { useTranslations } from "next-intl";

interface BookingHeaderProps {
  title: string;
  venue: string | null;
  date: string;
  imageUrl?: string | null;
  holdExpiresAt?: string | null;
  onHoldExpired?: () => void;
  /** 이전 기록이 없을 때(홈 화면 앱으로 바로 연 경우 등) 돌아갈 곳 */
  backHref?: string;
}

function formatDate(
  dateStr: string,
  weekdayLabels: string[],
  monthSuffix: string,
  daySuffix: string,
): string {
  try {
    const d = new Date(dateStr);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const weekday = weekdayLabels[d.getDay()];
    const hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, "0");
    return `${month}${monthSuffix} ${day}${daySuffix} (${weekday}) ${hours}:${minutes}`;
  } catch {
    return dateStr;
  }
}

function useCountdown(
  expiresAt: string | null | undefined,
  onExpired?: () => void,
) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const expiredCalled = useRef(false);

  useEffect(() => {
    expiredCalled.current = false;
  }, [expiresAt]);

  useEffect(() => {
    if (!expiresAt) {
      setRemainingMs(null);
      return;
    }

    const target = new Date(expiresAt).getTime();
    const update = () => {
      const diff = target - Date.now();
      setRemainingMs(diff > 0 ? diff : 0);
      if (diff <= 0 && !expiredCalled.current) {
        expiredCalled.current = true;
        onExpired?.();
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [expiresAt, onExpired]);

  if (remainingMs === null) return null;

  const totalSec = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const isUrgent = totalSec < 60;
  const isExpired = totalSec <= 0;

  return {
    label: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    isUrgent,
    isExpired,
  };
}

export default function BookingHeader({
  title,
  venue,
  date,
  imageUrl,
  holdExpiresAt,
  onHoldExpired,
  backHref,
}: BookingHeaderProps) {
  const t = useTranslations("booking.header");
  const tCommon = useTranslations("common");
  const router = useRouter();
  // 홈 화면 앱(PWA)에는 브라우저 뒤로 가기 버튼이 없으므로 화면 안에 둔다.
  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push(backHref ?? "/");
  };
  const countdown = useCountdown(holdExpiresAt, onHoldExpired);

  const weekdayLabels = [
    t("weekdaySun"),
    t("weekdayMon"),
    t("weekdayTue"),
    t("weekdayWed"),
    t("weekdayThu"),
    t("weekdayFri"),
    t("weekdaySat"),
  ];

  return (
    <header className="shrink-0 z-40 border-b border-border bg-background">
      <div className="flex items-center justify-between gap-2 px-2 sm:px-5 py-3">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <button
            type="button"
            onClick={goBack}
            aria-label={tCommon("back")}
            className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-muted active:scale-95"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          {/* 포스터 이미지 */}
          <div className="hidden sm:block shrink-0 w-10 h-14 rounded-lg overflow-hidden bg-muted">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지 URL, next/image remotePatterns 없이 fill 불가
              <img
                src={imageUrl}
                alt={title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
                <Calendar className="w-4 h-4" />
              </div>
            )}
          </div>

          {/* Event info */}
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-foreground truncate">
              {title}
            </h1>
            <div className="flex items-center gap-3 mt-0.5 min-w-0">
              <span className="flex shrink-0 items-center gap-1 text-xs sm:text-sm text-muted-foreground">
                <Calendar className="w-3.5 h-3.5 shrink-0" />
                {formatDate(date, weekdayLabels, t("monthSuffix"), t("daySuffix"))}
              </span>
              {venue && (
                <span className="flex min-w-0 items-center gap-1 text-xs sm:text-sm text-muted-foreground truncate">
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  {venue}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Hold countdown timer */}
        {countdown && !countdown.isExpired && (
          <div
            role="timer"
            aria-live="polite"
            className={cn(
              "shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold tabular-nums",
              countdown.isUrgent
                ? "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 animate-pulse"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20",
            )}
          >
            <Clock className="w-3.5 h-3.5" />
            {countdown.label}
          </div>
        )}
      </div>
    </header>
  );
}

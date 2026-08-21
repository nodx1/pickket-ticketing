"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@pickket/ui";
import { AlertTriangle, Clock } from "lucide-react";

interface SlaTimerProps {
  deadline: string | null | undefined;
  status: string;
}

function getTimeRemaining(
  deadline: string,
  t: ReturnType<typeof useTranslations>,
): {
  overdue: boolean;
  label: string;
  totalMinutes: number;
} {
  const now = Date.now();
  const target = new Date(deadline).getTime();
  const diff = target - now;

  if (diff <= 0) {
    const overMinutes = Math.abs(Math.floor(diff / 60000));
    if (overMinutes < 60)
      return {
        overdue: true,
        label: t("minutesOverdue", { minutes: overMinutes ?? 0 }),
        totalMinutes: -overMinutes,
      };
    const hours = Math.floor(overMinutes / 60);
    return {
      overdue: true,
      label: t("hoursOverdue", { hours }),
      totalMinutes: -overMinutes,
    };
  }

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60)
    return {
      overdue: false,
      label: t("minutesRemaining", { minutes: minutes ?? 0 }),
      totalMinutes: minutes,
    };
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return {
      overdue: false,
      label: t("hoursMinutesRemaining", {
        hours,
        minutes: minutes % 60,
      }),
      totalMinutes: minutes,
    };
  const days = Math.floor(hours / 24);
  return {
    overdue: false,
    label: t("daysHoursRemaining", {
      days: days ?? 0,
      hours: hours % 24,
    }),
    totalMinutes: minutes,
  };
}

export default function SlaTimer({ deadline, status }: SlaTimerProps) {
  const t = useTranslations("cs.slaTimer");
  const isTerminal = status === "resolved" || status === "closed";

  // 초기값을 즉시 계산하여 첫 렌더 플래시 방지
  const [time, setTime] = useState<ReturnType<typeof getTimeRemaining> | null>(
    () => (deadline && !isTerminal ? getTimeRemaining(deadline, t) : null),
  );

  useEffect(() => {
    if (!deadline || isTerminal) {
      setTime(null);
      return;
    }
    setTime(getTimeRemaining(deadline, t));
    const interval = setInterval(() => {
      setTime(getTimeRemaining(deadline, t));
    }, 60000);
    return () => clearInterval(interval);
  }, [deadline, isTerminal, t]);

  if (!deadline || isTerminal) {
    return null;
  }

  if (!time) return null;

  if (time.overdue) {
    return (
      <Badge className="rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 gap-1">
        <AlertTriangle className="h-3 w-3" />
        SLA {time.label}
      </Badge>
    );
  }

  // Warning state: less than 30 min
  if (time.totalMinutes < 30) {
    return (
      <Badge className="rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 gap-1">
        <Clock className="h-3 w-3" />
        {time.label}
      </Badge>
    );
  }

  return (
    <Badge
      className="rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 gap-1"
      variant="secondary"
    >
      <Clock className="h-3 w-3" />
      {time.label}
    </Badge>
  );
}

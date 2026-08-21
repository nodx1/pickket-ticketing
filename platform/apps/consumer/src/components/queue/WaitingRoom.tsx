"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  buildEventWebSocketUrl,
  WSManager,
  type WSMessage,
} from "@pickket/lib/ws";
import { getRemainingCooldown } from "@pickket/lib/retry-guard";

interface WaitingRoomProps {
  eventId: string;
  initialPosition?: number;
  onAdmitted?: () => void;
}

export function WaitingRoom({
  eventId,
  initialPosition,
  onAdmitted,
}: WaitingRoomProps) {
  const t = useTranslations("queue.waitingRoom");
  const [position, setPosition] = useState(initialPosition ?? 0);
  const [estimatedWait, setEstimatedWait] = useState(0); // seconds
  const [status, setStatus] = useState<"waiting" | "admitted" | "error">(
    "waiting",
  );
  const [cooldown, setCooldown] = useState(0);
  const wsRef = useRef<WSManager | null>(null);

  // WebSocket for queue position updates
  useEffect(() => {
    const manager = new WSManager({
      url: buildEventWebSocketUrl(eventId, process.env.NEXT_PUBLIC_WS_URL),
      onMessage: (msg: WSMessage) => {
        if (msg.type === "queue_position" && msg.data) {
          const pos = msg.data.position as number;
          const wait = msg.data.estimated_wait as number;
          setPosition(pos);
          setEstimatedWait(wait);

          if (pos === 0) {
            setStatus("admitted");
            onAdmitted?.();
          }
        }
      },
    });

    manager.connect();
    manager.subscribe("queue_position", eventId);
    wsRef.current = manager;

    return () => {
      manager.disconnect();
      wsRef.current = null;
    };
  }, [eventId, onAdmitted]);

  // Retry cooldown timer
  useEffect(() => {
    const tick = () => {
      const remaining = getRemainingCooldown();
      setCooldown(Math.ceil(remaining / 1000));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatWait = (seconds: number) => {
    if (seconds < 60) return t("waitSeconds", { seconds: seconds ?? 0 });
    const min = Math.ceil(seconds / 60);
    return t("waitMinutes", { min: min ?? 0 });
  };

  if (status === "admitted") {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <div className="text-4xl" role="img" aria-label={t("admittedCelebration")}>
          &#127881;
        </div>
        <h2 className="text-xl font-bold">{t("admittedTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("admittedSubtitle")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6 py-12">
      {/* Position display */}
      <div className="relative flex h-32 w-32 items-center justify-center">
        <svg
          className="absolute h-full w-full animate-spin-slow"
          viewBox="0 0 100 100"
        >
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="283"
            strokeDashoffset="70"
            className="text-primary/20"
          />
        </svg>
        <div className="text-center">
          <div className="text-3xl font-bold tabular-nums">
            {position.toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground">{t("queuePosition")}</div>
        </div>
      </div>

      <div className="text-center">
        <h2 className="text-lg font-semibold">{t("waitingTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("estimatedWait", { wait: formatWait(estimatedWait) })}
        </p>
      </div>

      {/* Progress hint */}
      <div className="w-64">
        <div className="h-1.5 w-full rounded-full bg-muted">
          <div
            className="h-1.5 rounded-full bg-primary transition-all duration-1000"
            style={{ width: `${Math.max(5, 100 - (position / 100) * 100)}%` }}
          />
        </div>
      </div>

      {/* Cooldown warning */}
      {cooldown > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {t("cooldownHint", { cooldown: cooldown ?? 0 })}
        </div>
      )}

      <p className="max-w-xs text-center text-xs text-muted-foreground">
        {t("notice")}
      </p>
    </div>
  );
}

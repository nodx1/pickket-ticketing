/**
 * EventOpenCountdown — 거대 카운트다운 (Laylo DNA)
 *
 * 페이지 주인공. tabular-nums로 jank 없이 렌더링.
 * 00:00:00에 도달하면 "티켓오픈 중" 상태로 전환.
 */

"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Props = {
  targetIso: string;
};

type Remaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isLive: boolean;
};

function calculateRemaining(targetIso: string): Remaining {
  const target = new Date(targetIso).getTime();
  const diff = target - Date.now();
  // 오픈일시 미설정/파싱불가(NaN) → 이미 오픈된 것으로 처리(NaN 카운트다운 방지).
  if (Number.isNaN(target) || diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, isLive: true };
  }
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  const seconds = Math.floor((diff / 1000) % 60);
  return { days, hours, minutes, seconds, isLive: false };
}

const pad = (n: number) => n.toString().padStart(2, "0");

export function EventOpenCountdown({ targetIso }: Props) {
  const t = useTranslations("event.openCountdown");
  const [remaining, setRemaining] = useState(() =>
    calculateRemaining(targetIso),
  );

  useEffect(() => {
    const tick = () => setRemaining(calculateRemaining(targetIso));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [targetIso]);

  if (remaining.isLive) {
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-3xl px-8 py-6"
        style={{
          background:
            "linear-gradient(135deg, var(--event-accent) 0%, color-mix(in oklab, var(--event-accent) 60%, #000) 100%)",
          color: "var(--event-accent-fg)",
        }}
      >
        <span className="text-sm font-semibold uppercase tracking-[0.2em]">
          LIVE
        </span>
        <span className="text-3xl font-black">{t("ticketOpenNow")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.25em] text-white/60">
        {t("timeRemaining")}
      </span>
      <div
        className="font-[var(--font-pretendard,Pretendard)] text-[clamp(3rem,14vw,6rem)] font-black leading-none tabular-nums"
        style={{
          fontVariantNumeric: "tabular-nums",
          color: "var(--event-accent)",
          textShadow:
            "0 0 40px color-mix(in oklab, var(--event-accent) 40%, transparent)",
        }}
      >
        {remaining.days > 0 && <>{t("days", { count: remaining.days ?? 0 })} </>}
        {pad(remaining.hours)}
        <span className="text-white/30">:</span>
        {pad(remaining.minutes)}
        <span className="text-white/30">:</span>
        {pad(remaining.seconds)}
      </div>
    </div>
  );
}

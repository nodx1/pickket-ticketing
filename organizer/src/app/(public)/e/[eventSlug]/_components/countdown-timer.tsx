"use client";

import { useEffect, useMemo, useState } from "react";

interface CountdownTimerProps {
  targetDate: string;
}

function calcTimeLeft(target: Date) {
  const diff = target.getTime() - Date.now();
  if (diff <= 0) return null;

  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

export function CountdownTimer({ targetDate }: CountdownTimerProps) {
  const target = useMemo(() => new Date(targetDate), [targetDate]);

  // tick=0은 SSR 초기값 (플레이스홀더 렌더), tick≥1은 클라이언트 (실제 카운트다운)
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // 첫 번째 tick을 10ms 후 발생시켜 SSR 플레이스홀더에서 전환
    const initial = setTimeout(() => setTick(1), 10);

    const interval = setInterval(() => {
      setTick((prev) => prev + 1);
    }, 1000);

    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [target]);

  // SSR 플레이스홀더 (하이드레이션 안전 — 서버/클라이언트 동일)
  if (tick === 0) {
    return (
      <div className="flex items-center gap-1.5">
        {["일", "시", "분", "초"].map((label) => (
          <div key={label} className="flex flex-col items-center rounded-md bg-primary-50 px-2.5 py-1.5">
            <span className="text-lg font-bold tabular-nums text-primary">--</span>
            <span className="text-[10px] text-content-subtle">{label}</span>
          </div>
        ))}
      </div>
    );
  }

  const timeLeft = calcTimeLeft(target);

  if (!timeLeft) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-xs font-semibold text-success">
        <span className="size-2 animate-pulse rounded-full bg-success" />
        진행 중
      </div>
    );
  }

  const segments = [
    { value: timeLeft.days, label: "일" },
    { value: timeLeft.hours, label: "시" },
    { value: timeLeft.minutes, label: "분" },
    { value: timeLeft.seconds, label: "초" },
  ];

  return (
    <div className="flex items-center gap-1.5">
      {segments.map((seg) => (
        <div
          key={seg.label}
          className="flex flex-col items-center rounded-md bg-primary-50 px-2.5 py-1.5"
        >
          <span className="text-lg font-bold tabular-nums text-primary">
            {String(seg.value).padStart(2, "0")}
          </span>
          <span className="text-[10px] text-content-subtle">{seg.label}</span>
        </div>
      ))}
    </div>
  );
}

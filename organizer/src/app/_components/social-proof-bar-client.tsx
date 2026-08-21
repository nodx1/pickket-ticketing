"use client";

import { useEffect, useRef, useState } from "react";
import { CreditCard, LayoutDashboard, Sparkles } from "lucide-react";

interface Stat {
  key: "events" | "tickets" | "live";
  icon: typeof Sparkles;
  value: number;
  suffix: string;
  label: string;
  sublabel: string;
  accent: "primary" | "accent" | "success";
  live?: boolean;
}

interface Props {
  eventCount: number;
  ticketCount: number;
  liveCount: number;
}

const accentStyles = {
  primary: {
    iconBg: "bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground",
    glow: "group-hover:shadow-[0_0_30px_rgba(108,92,231,0.35)]",
    bar: "from-primary via-primary to-accent",
    text: "text-primary",
  },
  accent: {
    iconBg: "bg-accent/10 text-accent group-hover:bg-accent group-hover:text-white",
    glow: "group-hover:shadow-[0_0_30px_rgba(139,92,246,0.35)]",
    bar: "from-accent via-accent to-primary",
    text: "text-accent",
  },
  success: {
    iconBg: "bg-success/10 text-success group-hover:bg-success group-hover:text-white",
    glow: "group-hover:shadow-[0_0_30px_rgba(5,150,105,0.35)]",
    bar: "from-success via-success to-primary",
    text: "text-success",
  },
} as const;

function useCountUp(target: number, inView: boolean, duration = 1600) {
  // 초기값을 target으로 설정 — 서버 렌더링 HTML과 일치시켜 hydration mismatch 방지
  const [value, setValue] = useState(target);
  const hasAnimated = useRef(false);
  useEffect(() => {
    if (!inView || hasAnimated.current) return;
    hasAnimated.current = true;
    // 한 번만 카운트업 애니메이션 실행 (0 → target)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(0); // 클라이언트에서만 0으로 리셋 후 애니메이션 시작
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setValue(Math.round(target * eased));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, inView, duration]);
  return value;
}

export function SocialProofBarClient({ eventCount, ticketCount, liveCount }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setInView(true);
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const animatedEvents = useCountUp(eventCount, inView);
  const animatedTickets = useCountUp(ticketCount, inView, 2000);
  const animatedLive = useCountUp(liveCount, inView, 1200);

  const stats: Stat[] = [
    {
      key: "events",
      icon: Sparkles,
      value: animatedEvents,
      suffix: "개",
      label: "만들어진 이벤트",
      sublabel: "AI 평균 4분 22초",
      accent: "primary",
    },
    {
      key: "tickets",
      icon: CreditCard,
      value: animatedTickets,
      suffix: "장",
      label: "발행된 티켓",
      sublabel: "수수료 최저 3%",
      accent: "accent",
    },
    {
      key: "live",
      icon: LayoutDashboard,
      value: animatedLive,
      suffix: "개",
      label: "지금 운영 중",
      sublabel: "실시간 대시보드",
      accent: "success",
      live: true,
    },
  ];

  return (
    <div ref={containerRef} className="mx-auto max-w-7xl px-6 lg:px-10">
      <div className="group/bar relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {/* 배경 그라디언트 애니메이션 */}
        <div
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-700 group-hover/bar:opacity-100"
          style={{
            background:
              "radial-gradient(600px circle at var(--x, 50%) var(--y, 50%), rgba(108,92,231,0.08), transparent 60%)",
          }}
        />

        <div className="relative grid gap-0 sm:grid-cols-3">
          {stats.map((stat, idx) => {
            const style = accentStyles[stat.accent];
            const Icon = stat.icon;
            return (
              <div
                key={stat.key}
                className={`group relative flex items-center gap-5 px-6 py-7 transition-all duration-300 hover:bg-muted/40 sm:px-8 sm:py-8 ${style.glow}`}
              >
                {/* 좌측 구분선 (첫번째 제외) */}
                {idx > 0 ? (
                  <div className="absolute left-0 top-1/2 hidden h-16 w-px -translate-y-1/2 bg-gradient-to-b from-transparent via-border to-transparent sm:block" />
                ) : null}

                {/* 아이콘 */}
                <div
                  className={`relative flex size-14 shrink-0 items-center justify-center rounded-2xl transition-all duration-300 group-hover:scale-110 group-hover:rotate-3 ${style.iconBg}`}
                >
                  <Icon className="size-6" />
                  {stat.live ? (
                    <span className="absolute -right-1 -top-1 flex size-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                      <span className="relative inline-flex size-3 rounded-full bg-success ring-2 ring-card" />
                    </span>
                  ) : null}
                </div>

                {/* 숫자 + 레이블 */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1">
                    <p className="text-3xl font-black tracking-tight tabular-nums text-foreground transition-colors duration-300 sm:text-4xl">
                      {stat.value.toLocaleString("ko-KR")}
                    </p>
                    <span className={`text-xl font-bold ${style.text}`}>{stat.suffix}</span>
                  </div>
                  <p className="mt-0.5 truncate text-sm font-semibold text-foreground">
                    {stat.label}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{stat.sublabel}</p>

                  {/* 라이브 뱃지 */}
                  <div className="mt-2 flex items-center gap-2">
                    {stat.live ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-success">
                        <span className="relative flex size-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                          <span className="relative inline-flex size-1.5 rounded-full bg-success" />
                        </span>
                        LIVE
                      </span>
                    ) : null}
                  </div>

                  {/* 하단 프로그레스 바 */}
                  <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full bg-gradient-to-r ${style.bar} transition-all duration-[2000ms] ease-out`}
                      style={{
                        width: inView ? `${60 + (idx * 12)}%` : "0%",
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

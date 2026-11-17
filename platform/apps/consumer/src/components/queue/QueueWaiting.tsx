"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@pickket/ui";
import { ArrowRight } from "lucide-react";

interface QueueWaitingProps {
  position: number;
  totalWaiting: number;
  estimatedWaitSeconds: number;
  isActive: boolean;
  purchaseDeadline: number | null;
  onLeave: () => void;
  onEnter: () => void;
  eventTitle: string;
}

function AnimatedNumber({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const applyReducedValue = useCallback((nextValue: number) => {
    setDisplay(nextValue);
  }, []);

  useEffect(() => {
    if (value === prev.current) return;
    const from = prev.current;
    const to = value;
    prev.current = to;

    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (prefersReduced) {
      const timeoutId = window.setTimeout(() => {
        applyReducedValue(to);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }

    const duration = 600;
    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }, [value, applyReducedValue]);

  return <>{display.toLocaleString("ko-KR")}</>;
}

function PulsingDots() {
  return (
    <span className="inline-flex items-center gap-1 ml-1 motion-reduce:hidden">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-1.5 h-1.5 rounded-full bg-white/60"
          style={{
            animation: `queuePulse 1.4s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

function ProgressRing({
  position,
  total,
  isActive,
}: {
  position: number;
  total: number;
  isActive: boolean;
}) {
  const t = useTranslations("queue.waiting");
  const radius = 100;
  const stroke = 6;
  const normalizedRadius = radius - stroke / 2;
  const circumference = 2 * Math.PI * normalizedRadius;

  const progress = total > 0 ? Math.max(0, 1 - (position - 1) / total) : 0;
  const offset = circumference - progress * circumference;

  return (
    <div className="relative flex items-center justify-center">
      <svg
        width={radius * 2}
        height={radius * 2}
        className="transform -rotate-90"
      >
        <circle
          cx={radius}
          cy={radius}
          r={normalizedRadius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-white/10"
        />
        <circle
          cx={radius}
          cy={radius}
          r={normalizedRadius}
          fill="none"
          stroke={isActive ? "#059669" : "var(--primary)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={isActive ? 0 : offset}
          className="transition-all duration-700 ease-out"
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {isActive ? (
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 12 }}
            className="text-center"
          >
            <div className="text-5xl mb-1">&#127881;</div>
            <p className="text-emerald-400 text-xl font-bold tracking-tight">
              {t("entryReady")}
            </p>
          </motion.div>
        ) : (
          <div className="text-center">
            <p className="text-white/50 text-xs font-medium uppercase tracking-widest mb-1">
              {t("myPosition")}
            </p>
            <div className="text-white text-5xl sm:text-6xl font-black font-tabular leading-none">
              <AnimatedNumber value={position} />
            </div>
            <p className="text-white/40 text-xs mt-1.5">{t("positionSuffix")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function formatWaitTime(
  seconds: number,
  t: ReturnType<typeof useTranslations<"queue.waiting">>,
): string {
  if (seconds <= 0) return t("waitTimeSoon");
  if (seconds < 60) return t("waitTimeSeconds", { seconds: seconds ?? 0 });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t("waitTimeMinutes", { minutes: minutes ?? 0 });
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0
    ? t("waitTimeHoursMinutes", { hours: hours ?? 0, remaining: remaining ?? 0 })
    : t("waitTimeHours", { hours: hours ?? 0 });
}

function formatDeadline(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function CelebrationParticles() {
  const prefersReduced = useMemo(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const [particles] = useState(() => {
    if (prefersReduced) return [];
    return Array.from({ length: 24 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      delay: Math.random() * 2,
      duration: 2 + Math.random() * 3,
      size: 4 + Math.random() * 8,
      color: ["#059669", "#0a0a0a", "#D97706", "#DC2626", "#737373"][
        Math.floor(Math.random() * 5)
      ],
    }));
  });

  if (prefersReduced) return null;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            animation: `confettiFall ${p.duration}s ease-in ${p.delay}s infinite`,
            opacity: 0,
          }}
        />
      ))}
    </div>
  );
}

function PurchaseDeadlineTimer({ deadline }: { deadline: number }) {
  const t = useTranslations("queue.waiting");
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, deadline - Date.now()),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(Math.max(0, deadline - Date.now()));
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const isUrgent = remaining < 3 * 60 * 1000;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`w-full rounded-2xl px-4 py-4 text-center ${
        isUrgent
          ? "bg-red-500/20 border border-red-500/30"
          : "bg-amber-500/15 border border-amber-500/20"
      }`}
    >
      <p
        className={`text-xs font-medium mb-0.5 ${
          isUrgent ? "text-red-400" : "text-amber-300"
        }`}
      >
        {t("purchaseTimeLabel")}
      </p>
      <p
        className={`text-2xl sm:text-3xl font-bold font-tabular ${
          isUrgent
            ? "text-red-400 animate-pulse motion-reduce:animate-none"
            : "text-amber-300"
        }`}
      >
        {formatDeadline(remaining)}
      </p>
      {remaining <= 0 && (
        <p className="text-xs text-red-500 mt-1">
          {t("purchaseTimeExpired")}
        </p>
      )}
    </motion.div>
  );
}

export default function QueueWaiting({
  position,
  totalWaiting,
  estimatedWaitSeconds,
  isActive,
  purchaseDeadline,
  onLeave,
  onEnter,
  eventTitle,
}: QueueWaitingProps) {
  const t = useTranslations("queue.waiting");
  const safePosition = Math.max(1, position);
  const [countdown, setCountdown] = useState(estimatedWaitSeconds);
  const [minWaitDone, setMinWaitDone] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMinWaitDone(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  isActive = isActive && minWaitDone;

  useEffect(() => {
    setCountdown(estimatedWaitSeconds);
  }, [estimatedWaitSeconds]);

  useEffect(() => {
    if (isActive || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [isActive, countdown]);

  return (
    <>
      <style jsx global>{`
        @keyframes queuePulse {
          0%,
          80%,
          100% {
            opacity: 0.3;
            transform: scale(0.8);
          }
          40% {
            opacity: 1;
            transform: scale(1);
          }
        }
        @keyframes confettiFall {
          0% {
            transform: translateY(-20px) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh) rotate(720deg);
            opacity: 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes queuePulse {
            0%,
            100% {
              opacity: 1;
              transform: scale(1);
            }
          }
          @keyframes confettiFall {
            0%,
            100% {
              opacity: 0;
            }
          }
        }
      `}</style>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
        className="fixed inset-0 z-50 flex items-center justify-center"
      >
        {/* 다크 배경 */}
        <div className="absolute inset-0 bg-[#0f0f14]" />

        {/* 그리드 패턴 */}
        <div className="absolute inset-0 opacity-[0.03] grid-pattern-dark" />

        {/* 폭죽 파티클 */}
        <AnimatePresence>
          {isActive && <CelebrationParticles />}
        </AnimatePresence>
        <motion.div
          initial={{ scale: 0.95, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 20 }}
          className="relative z-10 w-full max-w-md mx-4 flex flex-col items-center"
        >
          {/* 이벤트 제목 */}
          <motion.p
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-white/40 text-sm font-medium text-center mb-2 truncate max-w-full px-4"
          >
            {eventTitle}
          </motion.p>

          {/* 상태 라벨 */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="mb-8"
          >
            {isActive ? (
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                </span>
                <span className="text-emerald-400 text-sm font-semibold tracking-wide">
                  {t("entryTurn")}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                </span>
                <span className="text-white/60 text-sm font-medium tracking-wide">
                  {t("queueInProgress")}
                  <PulsingDots />
                </span>
              </div>
            )}
          </motion.div>

          {/* 프로그레스 링 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 150 }}
            className="mb-8"
          >
            <ProgressRing
              position={safePosition}
              total={totalWaiting}
              isActive={isActive}
            />
          </motion.div>

          {/* 구매 타이머 */}
          {isActive && purchaseDeadline && (
            <div className="w-full px-2 mb-4">
              <PurchaseDeadlineTimer deadline={purchaseDeadline} />
            </div>
          )}

          {/* 정보 카드 */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="w-full grid grid-cols-2 gap-3 mb-8"
          >
            <div className="bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] rounded-2xl px-4 py-4 text-center">
              <p className="text-white/40 text-xs font-medium uppercase tracking-wider mb-1">
                {t("currentWaiting")}
              </p>
              <p className="text-white text-xl font-bold font-tabular">
                <AnimatedNumber value={totalWaiting} />
                <span className="text-white/30 text-sm font-normal ml-0.5">
                  {t("peopleUnit")}
                </span>
              </p>
            </div>

            <div className="bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] rounded-2xl px-4 py-4 text-center">
              <p className="text-white/40 text-xs font-medium uppercase tracking-wider mb-1">
                {t("estimatedWaitTime")}
              </p>
              <p className="text-white text-xl font-bold font-tabular">
                {isActive ? (
                  <span className="text-emerald-400">{t("waitTimeNow")}</span>
                ) : (
                  formatWaitTime(countdown, t)
                )}
              </p>
            </div>
          </motion.div>

          {/* 안내 텍스트 */}
          <AnimatePresence mode="wait">
            {isActive ? (
              <motion.div
                key="active"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="text-center mb-8 px-4"
              >
                <p className="text-white/50 text-sm leading-relaxed">
                  {t("waitingComplete")}
                  <br />
                  {t("waitingCompleteCta")}
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="waiting"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="text-center mb-8 px-4"
              >
                <p className="text-white/50 text-sm leading-relaxed">
                  {t("waitingPositionBefore")}{" "}
                  <span className="text-white font-semibold">
                    {safePosition.toLocaleString("ko-KR")}{t("waitingPositionOrdinal")}
                  </span>{" "}
                  {t("waitingPositionAfter")}
                  <br />
                  {t("waitingHint")}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 버튼 */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="w-full flex flex-col gap-3 px-2"
          >
            <Button
              onClick={isActive ? onEnter : undefined}
              disabled={!isActive}
              className={`w-full h-14 rounded-xl text-lg font-bold ${
                isActive
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                  : "bg-white/[0.04] border border-white/[0.06] text-white/40 hover:bg-white/[0.04]"
              }`}
            >
              {isActive ? (
                <>
                  {t("enterButton")}
                  <ArrowRight className="h-5 w-5 ml-1" />
                </>
              ) : (
                <>
                  {t("waitingButton")}
                  <PulsingDots />
                </>
              )}
            </Button>

            <button
              onClick={onLeave}
              className="w-full h-11 rounded-xl text-white/30 hover:text-white/60 text-sm font-medium transition-colors duration-200 hover:bg-white/[0.03]"
            >
              {t("leaveQueue")}
            </button>
          </motion.div>

          {/* 하단 안내 */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="text-white/20 text-xs text-center mt-6 leading-relaxed"
          >
            {t("footerWarning")}
            <br />{t("footerStay")}
          </motion.p>
        </motion.div>
      </motion.div>
    </>
  );
}

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useTranslations } from "next-intl";

/* ── Types & Data ────────────────────────────────────────────────── */

type Phase = "input" | "weight" | "sort" | "pricing" | "result";

type TranslateFunction = ReturnType<typeof useTranslations>;

const BIDDERS = [
  { id: "A", bid: 150000, weight: 1.72 },
  { id: "B", bid: 120000, weight: 1.35 },
  { id: "C", bid: 95000, weight: 0.88 },
];

const SCORES = BIDDERS.map((b) => ({
  ...b,
  score: Math.round(b.weight * b.bid),
}));

const SORTED = [...SCORES].sort((a, b) => b.score - a.score);
const K = 2;
const LOSER_SCORE = SORTED[K].score; // 83,600

const WINNERS = SORTED.slice(0, K).map((b) => ({
  ...b,
  price: Math.round(LOSER_SCORE / b.weight),
  pct: Math.round((LOSER_SCORE / b.weight / b.bid) * 100),
}));

const PHASE_TIMING: { phase: Phase; delay: number }[] = [
  { phase: "input", delay: 0 },
  { phase: "weight", delay: 4000 },
  { phase: "sort", delay: 7500 },
  { phase: "pricing", delay: 11000 },
  { phase: "result", delay: 15000 },
];

const LOOP_DURATION = 20000;

/* ── Bidder name keys mapped by ID ───────────────────────────────── */

const BIDDER_NAME_KEYS: Record<string, string> = {
  A: "bidder_a_name",
  B: "bidder_b_name",
  C: "bidder_c_name",
};

/* ── Count-up hook ───────────────────────────────────────────────── */

function useCountUp(target: number, active: boolean, duration = 600) {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);
  const resetValue = useCallback(() => {
    setValue(0);
  }, []);

  useEffect(() => {
    if (!active) {
      const timeoutId = window.setTimeout(() => {
        resetValue();
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
    const start = performance.now();
    const animate = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(target * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, active, duration, resetValue]);

  return value;
}

/* ── Sub-components ──────────────────────────────────────────────── */

const lineVariants = {
  hidden: { opacity: 0, x: -12 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: {
      delay: i * 0.45,
      duration: 0.35,
      ease: [0, 0, 0.2, 1] as const,
    },
  }),
};

function Prompt({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 mt-2 first:mt-0">
      <span className="text-cyan font-bold select-none shrink-0">&gt;</span>
      <span className="text-[#E8ECF8]">{children}</span>
    </div>
  );
}

function Cursor() {
  return (
    <span className="inline-block w-[7px] h-[14px] bg-cyan ml-1 align-middle animate-cursor-blink" />
  );
}

function NumberCell({ value, active }: { value: number; active: boolean }) {
  const displayed = useCountUp(value, active);
  return (
    <span className="text-cyan font-bold tabular-nums">
      {displayed.toLocaleString()}
    </span>
  );
}

/* ── Phase Renders ───────────────────────────────────────────────── */

function PhaseInput({ t }: { t: TranslateFunction }) {
  return (
    <motion.div
      key="input"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Prompt>
        {t("stage1_prompt")}
        <Cursor />
      </Prompt>
      <div className="mt-3 space-y-1.5 pl-4">
        {BIDDERS.map((b, i) => (
          <motion.div
            key={b.id}
            custom={i}
            variants={lineVariants}
            initial="hidden"
            animate="visible"
            className="flex items-center gap-2 md:gap-3"
          >
            <span className="text-[#7B8CDE] w-4 shrink-0">{b.id}</span>
            <span className="text-[#E8ECF8] w-14 md:w-16 shrink-0">
              {t(BIDDER_NAME_KEYS[b.id])}
            </span>
            <span className="text-[#E8ECF8] tabular-nums">
              &#8361;{b.bid.toLocaleString()}
            </span>
            <span className="text-white/30">(w={b.weight.toFixed(2)})</span>
          </motion.div>
        ))}
      </div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.8 }}
      >
        <Prompt>
          K = <span className="text-cyan font-bold">2</span>
          {t("stage1_allocation_start")}
        </Prompt>
      </motion.div>
    </motion.div>
  );
}

function PhaseWeight({ t: _t }: { t: TranslateFunction }) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setActive(true), 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <motion.div
      key="weight"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Prompt>
        score<sub>i</sub> = w<sub>i</sub> &times; b<sub>i</sub>
        <Cursor />
      </Prompt>
      <div className="mt-3 space-y-1.5 pl-4">
        {SCORES.map((b, i) => (
          <motion.div
            key={b.id}
            custom={i}
            variants={lineVariants}
            initial="hidden"
            animate="visible"
            className="flex items-center gap-1.5 md:gap-2 flex-wrap"
          >
            <span className="text-[#7B8CDE] w-4 shrink-0">{b.id}:</span>
            <span className="text-white/60 tabular-nums">
              {b.weight.toFixed(2)} &times; {b.bid.toLocaleString()}
            </span>
            <span className="text-white/30">=</span>
            <NumberCell value={b.score} active={active} />
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

function PhaseSort({ t }: { t: TranslateFunction }) {
  return (
    <motion.div
      key="sort"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Prompt>
        {t("stage3_prompt")}
        <Cursor />
      </Prompt>
      <div className="mt-3 space-y-1.5 pl-4">
        {SORTED.map((b, i) => {
          const isWinner = i < K;
          return (
            <motion.div
              key={b.id}
              custom={i}
              variants={lineVariants}
              initial="hidden"
              animate="visible"
              className={`flex items-center gap-2 md:gap-3 ${!isWinner ? "opacity-50" : ""}`}
            >
              <span className="text-[#7B8CDE] w-5 shrink-0 tabular-nums">
                #{i + 1}
              </span>
              <span className="text-[#E8ECF8] w-14 md:w-16 shrink-0">
                {t(BIDDER_NAME_KEYS[b.id])}
              </span>
              <span className="text-[#E8ECF8] tabular-nums">
                {b.score.toLocaleString()}
              </span>
              {isWinner ? (
                <motion.span
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{
                    type: "spring",
                    stiffness: 400,
                    damping: 15,
                    delay: i * 0.45 + 0.3,
                  }}
                  className="text-cyan font-bold"
                >
                  &#10003; {t("won")}
                </motion.span>
              ) : (
                <motion.span
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: i * 0.45 + 0.3 }}
                  className="text-[#FF6B6B] font-bold"
                >
                  &#10007; {t("lost")}
                </motion.span>
              )}
            </motion.div>
          );
        })}
      </div>
      {/* Cutoff line */}
      <div className="pl-4 my-2 flex items-center gap-2">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: "100%" }}
          transition={{ delay: 1.2, duration: 0.6, ease: "easeOut" }}
          className="h-px bg-white/20"
        />
        <span className="text-2xs text-white/30 whitespace-nowrap shrink-0">
          cutoff K={K}
        </span>
      </div>
    </motion.div>
  );
}

function PhasePricing({ t }: { t: TranslateFunction }) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setActive(true), 600);
    return () => clearTimeout(timer);
  }, []);

  return (
    <motion.div
      key="pricing"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Prompt>
        {t("stage4_prompt")}
        <Cursor />
      </Prompt>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="pl-4 mt-1 text-white/40 text-xs-plus md:text-xs"
      >
        m<sub>i</sub> = (w<sub>K+1</sub> &times; b<sub>K+1</sub>) / w
        <sub>i</sub>
      </motion.div>
      <div className="mt-3 space-y-2 pl-4">
        {WINNERS.map((w, i) => (
          <motion.div
            key={w.id}
            custom={i}
            variants={lineVariants}
            initial="hidden"
            animate="visible"
            className="flex items-center gap-1.5 md:gap-2 flex-wrap"
          >
            <span className="text-[#E8ECF8] w-14 md:w-16 shrink-0">
              {t(BIDDER_NAME_KEYS[w.id])}:
            </span>
            <span className="text-white/50 tabular-nums text-xs-plus md:text-xs">
              {LOSER_SCORE.toLocaleString()} / {w.weight.toFixed(2)}
            </span>
            <span className="text-white/30">=</span>
            <span className="text-[#E8ECF8]">&#8361;</span>
            <NumberCell value={w.price} active={active} />
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * 0.45 + 1.2 }}
              className="text-[#7B8CDE] text-xs-plus"
            >
              ({w.pct}%)
            </motion.span>
          </motion.div>
        ))}
      </div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2.2 }}
      >
        <Prompt>
          {t("stage4_final_lt_bid")}{" "}
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{
              type: "spring",
              stiffness: 400,
              damping: 15,
              delay: 2.5,
            }}
            className="text-cyan"
          >
            &#10003;
          </motion.span>
        </Prompt>
      </motion.div>
    </motion.div>
  );
}

function PhaseResult({ t }: { t: TranslateFunction }) {
  const guarantees = [
    { label: "공정성", descKey: "guarantee_dsic" },
    { label: "IR", descKey: "guarantee_ir" },
    { label: "Efficient", descKey: "guarantee_efficient" },
  ];

  return (
    <motion.div
      key="result"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="text-center text-[#7B8CDE] text-xs tracking-widest mb-4">
        {t("stage5_complete")}
      </div>
      <div className="space-y-2 pl-4">
        {guarantees.map((g, i) => (
          <motion.div
            key={g.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.4, duration: 0.35 }}
            className="flex items-center gap-3"
          >
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{
                type: "spring",
                stiffness: 400,
                damping: 12,
                delay: i * 0.4 + 0.15,
              }}
              className="text-cyan"
            >
              &#10003;
            </motion.span>
            <span className="text-cyan font-bold w-16 md:w-20 shrink-0">
              {g.label}
            </span>
            <span className="text-[#E8ECF8]/70">{t(g.descKey)}</span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

/* ── Main Component ──────────────────────────────────────────────── */

export default function FormulaAnimation() {
  const t = useTranslations("formula");
  const [phase, setPhase] = useState<Phase>("input");
  const [loopKey, setLoopKey] = useState(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  useEffect(() => {
    clearTimers();

    const newTimers = PHASE_TIMING.map(({ phase: p, delay }) =>
      setTimeout(() => setPhase(p), delay),
    );

    // Loop reset
    newTimers.push(
      setTimeout(() => {
        setPhase("input");
        setLoopKey((k) => k + 1);
      }, LOOP_DURATION),
    );

    timersRef.current = newTimers;
    return clearTimers;
  }, [loopKey, clearTimers]);

  const phaseComponents: Record<Phase, React.ReactNode> = {
    input: <PhaseInput t={t} />,
    weight: <PhaseWeight t={t} />,
    sort: <PhaseSort t={t} />,
    pricing: <PhasePricing t={t} />,
    result: <PhaseResult t={t} />,
  };

  return (
    <div
      className="rounded-xl border border-white/[0.08] overflow-hidden shadow-2xl shadow-black/30"
      aria-hidden="true"
    >
      {/* Terminal title bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-[#0a0f1f] border-b border-white/[0.06]">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
        </div>
        <span className="text-2xs text-white/30 ml-2 font-mono">
          {t("terminal_title")}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <motion.span
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="w-1.5 h-1.5 rounded-full bg-cyan"
          />
          <span className="text-2xs text-white/25 font-mono">
            {t("terminal_status")}
          </span>
        </div>
      </div>

      {/* Terminal body */}
      <div className="bg-[#0F1629] px-4 md:px-5 py-4 md:py-5 font-mono text-xs-plus md:text-sm min-h-[200px] md:min-h-[240px]">
        <AnimatePresence mode="wait">{phaseComponents[phase]}</AnimatePresence>
      </div>
    </div>
  );
}

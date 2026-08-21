"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { useTranslations } from "next-intl";

const PILLAR_NUMS = ["01", "02", "03", "04"] as const;
const PILLAR_KEYS = ["p1", "p2", "p3", "p4"] as const;

export default function ManifestoSection() {
  const t = useTranslations("promise");

  const pillars = PILLAR_NUMS.map((num, i) => ({
    num,
    label: t(`${PILLAR_KEYS[i]}.label`),
    desc: t(`${PILLAR_KEYS[i]}.desc`),
  }));

  return (
    <section
      id="manifesto"
      className="max-w-[1440px] mx-auto px-4 sm:px-10 pt-16 pb-14"
    >
      {/* 헤드라인: eyebrow 좌 + 대형 타이틀 우 */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-12">
        <p className="text-xs font-bold tracking-[0.14em] uppercase text-gray-600 dark:text-gray-400 sm:pb-1.5">
          {t("section_title")}
        </p>
        <motion.h2
          className="font-black tracking-tight text-gray-900 leading-[0.92] text-right"
          style={{ fontSize: "clamp(2rem, 4.5vw, 3.5rem)" }}
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          {t("manifesto_heading_line1")}
          <br />
          {t("manifesto_heading_line2")}
        </motion.h2>
      </div>

      {/* 서약 리스트 — 전폭 divider rows */}
      <div className="border-t border-gray-200">
        {pillars.map((p, i) => (
          <motion.div
            key={p.num}
            initial={{ opacity: 0, x: -12 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{
              duration: 0.5,
              delay: i * 0.08,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="group relative border-b border-gray-200 overflow-hidden"
          >
            {/* Hover: highlighter sweep */}
            <div className="absolute inset-0 bg-gray-50 translate-x-[-101%] group-hover:translate-x-0 transition-transform duration-500 ease-out pointer-events-none" />

            {/* 왼쪽 accent bar */}
            <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-gray-900 scale-y-0 group-hover:scale-y-100 transition-transform duration-300 origin-bottom" />

            <div className="relative flex items-center gap-6 sm:gap-10 py-6 pl-5">
              {/* P-number */}
              <span className="text-xs font-black tracking-[0.12em] text-gray-200 group-hover:text-gray-500 transition-colors duration-300 w-7 shrink-0 select-none">
                {p.num}
              </span>

              {/* 레이블 */}
              <span className="text-[15px] sm:text-base font-black text-gray-900 w-28 sm:w-36 shrink-0 leading-tight">
                {p.label}
              </span>

              {/* 설명 */}
              <p className="text-[13px] text-gray-600 dark:text-gray-400 leading-relaxed flex-1 hidden sm:block">
                {p.desc}
              </p>

              {/* 화살표 */}
              <span className="ml-auto text-gray-200 group-hover:text-gray-600 dark:text-gray-400 transition-all duration-300 group-hover:translate-x-1 text-sm shrink-0 pr-2">
                →
              </span>
            </div>

            {/* 모바일: 설명 아래 표시 */}
            <p className="sm:hidden text-[12px] text-gray-600 dark:text-gray-400 leading-relaxed px-5 pb-5 pl-[calc(1.25rem+1.75rem+1.5rem)] relative">
              {p.desc}
            </p>
          </motion.div>
        ))}
      </div>

      <div className="mt-8 flex justify-end">
        <Link
          href="/fairness"
          className="inline-flex items-center gap-2 text-[13px] font-semibold text-gray-600 dark:text-gray-400 hover:text-gray-900 transition-colors group"
        >
          {t("read_full")}
          <span className="group-hover:translate-x-1 transition-transform inline-block">
            →
          </span>
        </Link>
      </div>
    </section>
  );
}

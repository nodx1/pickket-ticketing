"use client";

import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";

/* ── Icon-only SVG helpers ── */
function IconQR() {
  return (
    <svg viewBox="0 0 20 20" className="w-4 h-4 fill-white/60">
      <path
        fillRule="evenodd"
        d="M3 4a1 1 0 011-1h3a1 1 0 011 1v3a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm2 2V5h1v1H5zM3 13a1 1 0 011-1h3a1 1 0 011 1v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3zm2 2v-1h1v1H5zM13 3a1 1 0 00-1 1v3a1 1 0 001 1h3a1 1 0 001-1V4a1 1 0 00-1-1h-3zm1 2v1h1V5h-1zM7 7a1 1 0 000 2h2a1 1 0 100-2H7zM6 9a1 1 0 011-1h1v2a1 1 0 01-1 1H7a1 1 0 01-1-1V9zm7 1a1 1 0 102 0 1 1 0 00-2 0zm-1 3a1 1 0 011-1h2a1 1 0 110 2h-2a1 1 0 01-1-1zm1 3a1 1 0 100 2 1 1 0 000-2zm-3-3a1 1 0 011-1h.01a1 1 0 110 2H11a1 1 0 01-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}
function IconBell() {
  return (
    <svg viewBox="0 0 20 20" className="w-4 h-4 fill-white/60">
      <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zm0 16a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg viewBox="0 0 20 20" className="w-4 h-4 fill-white/60">
      <path
        fillRule="evenodd"
        d="M12 7a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0V8.414l-4.293 4.293a1 1 0 01-1.414 0L8 10.414l-4.293 4.293a1 1 0 01-1.414-1.414l5-5a1 1 0 011.414 0L11 10.586 14.586 7H12z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const FEATURE_ICONS = [<IconQR key="qr" />, <IconBell key="bell" />, <IconChart key="chart" />];

/* ── Screen label prop bags ── */
interface ScreenQRLabels {
  back: string;
  venue: string;
  refreshLabel: string;
  refreshUnit: string;
  showScanner: string;
}
interface ScreenNotifLabels {
  title: string;
  count: string;
  viewAll: string;
  timeJustNow: string;
  time2min: string;
  time1hr: string;
  time3hr: string;
  bodyOpen1hr: string;
  bodyArtistAdded: string;
  bodySeatAssigned: string;
}
interface ScreenFanScoreLabels {
  title: string;
  topPct: string;
  stat1: string;
  stat2: string;
  stat3: string;
  stat2Val: string;
  stat3Val: string;
  simTitle: string;
  simSub: string;
  nextEvent: string;
  predicted: string;
}

/* ── 폰 화면 3종 ── */

function ScreenQR({ labels }: { labels: ScreenQRLabels }) {
  const [tick, setTick] = useState(14);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => (n <= 1 ? 15 : n - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  const CELLS = [
    1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0,
    0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0,
    1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1,
    0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0,
    0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1,
    1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0,
    0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0,
    0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1,
    0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0,
    0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1,
    1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1,
    0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0,
    1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1,
    1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];

  return (
    <div className="absolute inset-0 bg-[#0e0e12] flex flex-col text-white">
      <div className="flex justify-between items-center px-4 pt-10 pb-1 text-xs text-white/60">
        <span className="font-medium">9:41</span>
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 15 11" className="w-3 h-2.5 fill-white/30">
            <rect x="0" y="4" width="3" height="7" rx="0.5" />
            <rect x="4" y="2.5" width="3" height="8.5" rx="0.5" />
            <rect x="8" y="0.5" width="3" height="10.5" rx="0.5" />
            <rect x="12" y="0" width="3" height="11" rx="0.5" />
          </svg>
          <svg viewBox="0 0 20 12" className="w-4 h-2.5">
            <rect
              x="1"
              y="1"
              width="15"
              height="10"
              rx="2"
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="1.5"
              fill="none"
            />
            <rect
              x="2.5"
              y="2.5"
              width="9"
              height="7"
              rx="1"
              fill="rgba(255,255,255,0.3)"
            />
            <rect
              x="17"
              y="4"
              width="2"
              height="4"
              rx="1"
              fill="rgba(255,255,255,0.3)"
            />
          </svg>
        </div>
      </div>
      <div className="px-5 py-3 border-b border-white/[0.07]">
        <div className="text-xs text-white/60 mb-0.5 flex items-center gap-1">
          <span>←</span> {labels.back}
        </div>
        <div className="text-[14px] font-black leading-snug">
          BTS 월드투어 서울
        </div>
        <div className="text-xs text-white/60 mt-0.5">
          {labels.venue}
        </div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-5">
        <div className="w-[140px] h-[140px] bg-white rounded-2xl p-2.5 shadow-2xl shadow-black/60">
          <div
            className="w-full h-full"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(21, 1fr)",
              gap: "0.4px",
            }}
          >
            {CELLS.map((c, i) => (
              <div
                key={i}
                style={{
                  background: c ? "#0e0e12" : "#fff",
                  borderRadius: "0.4px",
                }}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-white/60">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span>{labels.refreshLabel}</span>
          <span className="font-black text-white/60 tabular-nums">
            {tick}{labels.refreshUnit}
          </span>
        </div>
      </div>
      <div className="px-5 pb-10">
        <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] px-4 py-2.5 text-center text-xs text-white/60">
          {labels.showScanner}
        </div>
      </div>
    </div>
  );
}

function ScreenNotifications({ labels }: { labels: ScreenNotifLabels }) {
  const NOTIFS = [
    {
      title: "BTS 월드투어 서울",
      body: labels.bodyOpen1hr,
      time: labels.timeJustNow,
      color: "#404040",
    },
    {
      title: "아이유 콘서트 추가 공연",
      body: "11/23 (토) 잠실 올림픽주경기장",
      time: labels.time2min,
      color: "#ec4899",
    },
    {
      title: "세븐틴 팬미팅",
      body: labels.bodyArtistAdded,
      time: labels.time1hr,
      color: "#3b82f6",
    },
    {
      title: "스트레이키즈 콘서트",
      body: labels.bodySeatAssigned,
      time: labels.time3hr,
      color: "#10b981",
    },
  ];

  return (
    <div className="absolute inset-0 bg-[#f4f3f1] flex flex-col">
      <div className="flex justify-between items-center px-4 pt-10 pb-1 text-xs text-gray-300">
        <span className="font-medium">9:41</span>
        <div className="w-14 h-2 rounded-full bg-gray-300/60" />
      </div>
      <div className="px-5 py-3 flex items-center justify-between">
        <span className="text-[14px] font-black text-gray-900">{labels.title}</span>
        <span className="text-xs font-bold text-gray-700 bg-gray-200 rounded-full px-2.5 py-1">
          {labels.count}
        </span>
      </div>
      <div className="flex-1 px-3 flex flex-col gap-1.5 overflow-hidden">
        {NOTIFS.map((n, i) => (
          <motion.div
            key={n.title}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              delay: i * 0.08,
              duration: 0.3,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="bg-white rounded-2xl px-3 py-2.5 shadow-sm flex items-start gap-2.5"
          >
            <span
              className="w-2 h-2 rounded-full mt-1 shrink-0"
              style={{ background: n.color }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold text-gray-900 truncate">
                {n.title}
              </div>
              <div className="text-xs text-gray-300 mt-0.5 leading-tight">
                {n.body}
              </div>
            </div>
            <span className="text-[8px] text-gray-300 shrink-0 mt-0.5">
              {n.time}
            </span>
          </motion.div>
        ))}
      </div>
      <div className="px-3 py-4 pb-10">
        <div className="h-10 rounded-2xl bg-gray-900 flex items-center justify-center shadow-lg shadow-black/20">
          <span className="text-xs font-bold text-white">
            {labels.viewAll}
          </span>
        </div>
      </div>
    </div>
  );
}

function ScreenFanScore({ labels }: { labels: ScreenFanScoreLabels }) {
  return (
    <div className="absolute inset-0 bg-[#0e0e12] flex flex-col text-white">
      <div className="flex justify-between items-center px-4 pt-10 pb-1 text-xs text-white/60">
        <span className="font-medium">9:41</span>
        <div className="flex gap-1.5">
          <div className="w-6 h-1.5 rounded-full bg-white/20" />
          <div className="w-4 h-1.5 rounded-full bg-white/20" />
        </div>
      </div>
      <div className="px-5 py-3 border-b border-white/[0.07] flex items-center justify-between">
        <span className="text-[14px] font-black">{labels.title}</span>
        <span className="text-xs text-white/70">BTS</span>
      </div>
      <div className="flex-1 px-4 py-4 flex flex-col gap-3">
        <div className="rounded-2xl bg-white/[0.07] border border-white/[0.10] p-4">
          <div className="text-[8px] text-white/60 tracking-[0.15em] uppercase mb-2">
            My Fan Score
          </div>
          <motion.div
            className="text-[36px] font-black leading-none tracking-tight"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            8,420
          </motion.div>
          <div className="flex items-center gap-2 mt-3">
            <div className="flex-1 h-[3px] rounded-full bg-white/10">
              <motion.div
                className="h-full rounded-full bg-white/70"
                initial={{ width: 0 }}
                animate={{ width: "78%" }}
                transition={{ duration: 1.2, delay: 0.2, ease: "easeOut" }}
              />
            </div>
            <span className="text-xs text-white/60 font-bold shrink-0">
              {labels.topPct}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: labels.stat1, val: "+340", accent: "text-emerald-400" },
            { label: labels.stat2, val: labels.stat2Val, accent: "text-white" },
            { label: labels.stat3, val: labels.stat3Val, accent: "text-white" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl bg-white/[0.05] border border-white/[0.08] p-2.5 text-center"
            >
              <div className={`text-[12px] font-black ${s.accent}`}>
                {s.val}
              </div>
              <div className="text-[8px] text-white/25 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
        <div className="rounded-xl bg-white/[0.06] border border-white/[0.08] px-3.5 py-3 flex items-center justify-between">
          <div>
            <div className="text-[8px] text-white/60 mb-0.5">
              {labels.simTitle}
            </div>
            <div className="text-xs font-bold text-white/60">
              {labels.simSub}
            </div>
          </div>
          <span className="text-white/70 text-sm">→</span>
        </div>
        <div className="mt-auto rounded-xl bg-white/[0.06] border border-white/[0.08] px-3.5 py-3">
          <div className="text-[8px] text-white/60 mb-1">
            {labels.nextEvent}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-[18px] font-black text-white">+580</span>
            <span className="text-xs text-white/70">{labels.predicted}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── QR 코드 (데스크탑 전용 다운로드 단축키) ── */
function QRPlaceholder() {
  const P = [
    1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1,
    0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1,
  ];
  return (
    <div
      className="w-14 h-14 bg-white rounded-lg p-1.5"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        gap: "1px",
      }}
    >
      {P.map((c, i) => (
        <div
          key={i}
          style={{ background: c ? "#111" : "#fff", borderRadius: "1px" }}
        />
      ))}
    </div>
  );
}

export default function AppDownloadSection() {
  const [active, setActive] = useState(0);
  const t = useTranslations("home.app_download");

  const qrLabels: ScreenQRLabels = {
    back: t("qr_screen_back"),
    venue: t("qr_screen_venue"),
    refreshLabel: t("qr_screen_refresh_label"),
    refreshUnit: t("qr_screen_refresh_unit"),
    showScanner: t("qr_screen_show"),
  };
  const notifLabels: ScreenNotifLabels = {
    title: t("notif_screen_title"),
    count: t("notif_screen_count", { count: 4 }),
    viewAll: t("notif_view_all"),
    timeJustNow: t("notif_time_just_now"),
    time2min: t("notif_time_2min"),
    time1hr: t("notif_time_1hr"),
    time3hr: t("notif_time_3hr"),
    bodyOpen1hr: t("notif_body_open_1hr"),
    bodyArtistAdded: t("notif_body_artist_added"),
    bodySeatAssigned: t("notif_body_seat_assigned"),
  };
  const fanScoreLabels: ScreenFanScoreLabels = {
    title: t("fanscore_screen_title"),
    topPct: t("fanscore_top_pct"),
    stat1: t("fanscore_stat1"),
    stat2: t("fanscore_stat2"),
    stat3: t("fanscore_stat3"),
    stat2Val: t("fanscore_stat2_val"),
    stat3Val: t("fanscore_stat3_val"),
    simTitle: t("fanscore_sim_title"),
    simSub: t("fanscore_sim_sub"),
    nextEvent: t("fanscore_next_event"),
    predicted: t("fanscore_predicted"),
  };

  const SCREEN_COUNT = 3;

  useEffect(() => {
    const timer = setInterval(
      () => setActive((p) => (p + 1) % SCREEN_COUNT),
      4000,
    );
    return () => clearInterval(timer);
  }, []);

  const features = [
    { label: t("feature1_label"), detail: t("feature1_detail") },
    { label: t("feature2_label"), detail: t("feature2_detail") },
    { label: t("feature3_label"), detail: t("feature3_detail") },
  ];

  const headingParts = t("heading").split("\n");

  return (
    <section className="max-w-[1440px] mx-auto px-4 sm:px-10 py-16">
      {/* 다크 카드 */}
      <div className="relative rounded-3xl bg-[#0d0c11] overflow-hidden">
        {/* 방사형 글로우 — 폰 뒤 */}
        <div
          className="absolute right-0 top-0 bottom-0 w-[55%] pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 60% 70% at 60% 50%, rgba(255,255,255,0.04) 0%, transparent 70%)",
          }}
        />

        <div className="relative grid grid-cols-1 lg:grid-cols-2 items-center gap-0">
          {/* ── 왼쪽: 카피 + 피처 + 버튼 */}
          <div className="px-6 sm:px-10 py-14 xl:px-14 xl:py-16">
            <motion.p
              className="text-xs font-bold tracking-[0.18em] uppercase text-white/70 mb-5"
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
            >
              {t("eyebrow")}
            </motion.p>

            <motion.h2
              className="font-black tracking-tight text-white leading-[0.92] mb-4"
              style={{ fontSize: "clamp(2.4rem, 3.8vw, 3.8rem)" }}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            >
              {headingParts[0]}
              <br />
              {headingParts[1] ?? ""}
            </motion.h2>

            <motion.p
              className="text-[13px] text-white/70 leading-relaxed mb-10 max-w-sm"
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
            >
              {t("subtext")}
            </motion.p>

            {/* 피처 리스트 */}
            <div className="flex flex-col gap-5 mb-10">
              {features.map((f, i) => (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => setActive(i)}
                  className="text-left group flex items-start gap-4"
                >
                  <div
                    className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${
                      active === i
                        ? "bg-white/15 border border-white/20"
                        : "bg-white/5 border border-white/[0.08] group-hover:bg-white/10"
                    }`}
                  >
                    {FEATURE_ICONS[i]}
                  </div>
                  <div>
                    <div
                      className={`text-[13px] font-bold transition-colors duration-200 ${active === i ? "text-white" : "text-white/50 group-hover:text-white/70"}`}
                    >
                      {f.label}
                    </div>
                    <div
                      className={`text-xs leading-relaxed mt-0.5 transition-colors duration-200 ${active === i ? "text-white/70" : "text-white/60"}`}
                    >
                      {f.detail}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* 다운로드 버튼 */}
            <div className="flex flex-wrap items-center gap-3">
              <a
                href="#"
                className="inline-flex items-center gap-2.5 h-11 px-6 rounded-full bg-white text-[12px] font-bold text-gray-900 hover:bg-gray-100 transition-colors"
              >
                <AppleLogo />
                App Store
              </a>
              <a
                href="#"
                className="inline-flex items-center gap-2.5 h-11 px-6 rounded-full bg-white/10 text-[12px] font-bold text-white border border-white/10 hover:bg-white/15 transition-colors"
              >
                <PlayLogo />
                Google Play
              </a>
              {/* QR — 데스크탑 전용 */}
              <div className="hidden xl:flex items-center gap-3 ml-1 pl-4 border-l border-white/10">
                <QRPlaceholder />
                <span className="text-xs text-white/70 leading-snug">
                  {t("scan_to_download").split("\n").map((line, i) => (
                    <span key={i}>{line}{i === 0 ? <br /> : null}</span>
                  ))}
                </span>
              </div>
            </div>

            <p className="text-xs text-white/60 mt-3">
              {t("platform_note")}
            </p>
          </div>

          {/* ── 오른쪽: 폰 목업 */}
          <div className="hidden lg:flex items-center justify-center py-10 px-8">
            <div className="flex flex-col items-center gap-5">
              {/* 폰 프레임 — 앱 미리보기 일러스트(데코). 스크린리더/axe 제외(저대비 목업 텍스트는
                  실제 콘텐츠 아님 — 실제 다운로드 CTA는 별도). */}
              <div
                aria-hidden="true"
                className="relative"
                style={{
                  width: 270,
                  height: 560,
                  borderRadius: 46,
                  border: "1.5px solid rgba(255,255,255,0.10)",
                  background: "#0e0e12",
                  overflow: "hidden",
                  boxShadow:
                    "0 40px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03)",
                }}
              >
                {/* 다이나믹 아일랜드 */}
                <div
                  className="absolute top-3.5 left-1/2 -translate-x-1/2 z-20 bg-black"
                  style={{ width: 94, height: 26, borderRadius: 20 }}
                />

                {/* 화면 전환 */}
                <AnimatePresence mode="wait">
                  <motion.div
                    key={active}
                    className="absolute inset-0"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                  >
                    {active === 0 && <ScreenQR labels={qrLabels} />}
                    {active === 1 && <ScreenNotifications labels={notifLabels} />}
                    {active === 2 && <ScreenFanScore labels={fanScoreLabels} />}
                  </motion.div>
                </AnimatePresence>

                {/* 홈바 */}
                <div
                  className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-20 rounded-full"
                  style={{
                    width: 100,
                    height: 4,
                    background: "rgba(255,255,255,0.15)",
                  }}
                />
              </div>

              {/* 진행 인디케이터 */}
              <div className="flex gap-2 items-center">
                {Array.from({ length: SCREEN_COUNT }).map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setActive(i)}
                    aria-label={t("screenshot_aria", { number: i + 1 })}
                    aria-current={i === active ? "true" : undefined}
                    className="relative rounded-full overflow-hidden transition-all duration-300"
                    style={{
                      width: i === active ? 28 : 6,
                      height: 4,
                      background:
                        i === active
                          ? "rgba(255,255,255,0.15)"
                          : "rgba(255,255,255,0.12)",
                    }}
                  >
                    {i === active && (
                      <motion.span
                        key={active}
                        className="absolute inset-y-0 left-0 rounded-full bg-white"
                        initial={{ width: "0%" }}
                        animate={{ width: "100%" }}
                        transition={{ duration: 4, ease: "linear" }}
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0 fill-current">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

function PlayLogo() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0 fill-current">
      <path d="M3.18 23.76c.3.17.64.24.99.19L15.34 12 11.74 8.4 3.18 23.76zM20.7 10.56l-2.68-1.53-3.8 3.38 3.8 3.38 2.7-1.54c.77-.44.77-1.26-.02-1.69zM2.12.46C1.82.77 1.64 1.24 1.64 1.86v20.28c0 .62.18 1.09.5 1.4l.07.07 11.37-11.37v-.27L2.12.46zM15.34 12L3.17.24c.35-.05.71.02 1.01.19l12.51 7.14-1.35 4.43z" />
    </svg>
  );
}

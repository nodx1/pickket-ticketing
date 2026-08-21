/**
 * MobilePreviewFrame — iPhone 프레임 안에서 모바일 앱 화면을 시뮬레이트.
 *
 * pickket.v2.app/app/e/[slug].tsx 파일의 StyleSheet를 CSS로 1:1 포팅.
 * Modal/ScrollView는 div로, ImageBackground는 background-image로 대체.
 */

"use client";

import { useEffect, useState } from "react";

import { useTranslations } from "next-intl";

import type { EventOpenData } from "../../_data";

type Props = {
  event: EventOpenData;
};

const DATE_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function MobilePreviewFrame({ event }: Props) {
  const t = useTranslations("event.mobilePreview");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitted, setSubmitted] = useState<number | null>(null);
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^01[0-9]{8,9}$/.test(phone.replace(/-/g, ""))) {
      alert(t("invalidPhone"));
      return;
    }
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 600));
    setSubmitting(false);
    setSubmitted(event.subscriberCount + 1);
  }

  function handleClose() {
    setSheetOpen(false);
    setSubmitted(null);
    setPhone("");
  }

  return (
    <div
      className="relative h-[844px] w-[390px] overflow-hidden rounded-[54px] border-[12px] border-neutral-800 bg-[#0A0A0A] shadow-[0_40px_80px_rgba(0,0,0,0.5)]"
      style={
        {
          "--event-accent": event.brandColor,
          "--event-accent-fg": event.brandColorFg,
        } as React.CSSProperties
      }
    >
      {/* Dynamic Island */}
      <div className="absolute left-1/2 top-2 z-50 h-[30px] w-[120px] -translate-x-1/2 rounded-full bg-black" />

      {/* Status bar */}
      <div className="absolute inset-x-0 top-0 z-40 flex h-12 items-center justify-between px-8 text-xs font-semibold text-white">
        <span>9:41</span>
        <span className="opacity-0">.</span>
      </div>

      {/* Scroll container */}
      <div className="h-full w-full overflow-y-auto scrollbar-hide">
        {/* Hero (ImageBackground equivalent) */}
        <section
          className="relative h-[540px] w-full bg-cover bg-center"
          style={{ backgroundImage: `url(${event.heroImage})` }}
        >
          {/* Gradient overlays (LinearGradient × 2) */}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/40 to-[#0A0A0A]" />
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(180deg, ${event.brandColor}30 0%, transparent 100%)`,
            }}
          />

          {/* Hero text */}
          <div className="absolute inset-x-0 bottom-8 z-10 flex flex-col items-center px-6 text-center">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.2em] text-white/70">
              {t("ticketOpenSoon")}
            </p>
            <h2
              className="text-[34px] font-black leading-[1.1] tracking-tight text-white"
              style={{ textShadow: "0 2px 24px rgba(0,0,0,0.5)" }}
            >
              {event.title}
            </h2>
            <p className="mt-4 text-[15px] text-white/85">{event.venue}</p>
            <p className="mt-1 text-[13px] text-white/60">
              {event.ticketOpenAt
                ? DATE_FORMAT.format(new Date(event.ticketOpenAt))
                : t("dateTbd")}{" "}
              {t("open")}
            </p>
          </div>
        </section>

        {/* CTA Section */}
        <section className="flex flex-col items-center gap-8 px-6 pt-10 pb-8">
          <MobileCountdown
            targetIso={event.ticketOpenAt ?? ""}
            accent={event.brandColor}
          />

          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex h-14 w-full max-w-[320px] items-center justify-center rounded-full text-base font-bold shadow-[0_8px_24px_rgba(0,0,0,0.3)] active:scale-[0.98]"
            style={{
              backgroundColor: event.brandColor,
              color: event.brandColorFg,
            }}
          >
            📱 {t("notifyMeCta")}
          </button>

          <p className="-mt-4 text-[12px] text-white/50">
            {t("subscriberCountPrefix")}{" "}
            <strong className="font-bold text-white/80">
              {event.subscriberCount.toLocaleString()}{t("subscriberCountUnit")}
            </strong>
            {t("subscriberCountSuffix")}
          </p>

          <p className="-mt-2 text-center text-[13px] leading-5 text-white/60">
            {t("notifyScheduleLine1")}
            <br />{t("notifyScheduleLine2")}
          </p>
        </section>

        <p className="pb-10 text-center text-[11px] text-white/40">
          powered by <span className="font-bold">Pickket</span>
        </p>
      </div>

      {/* Bottom sheet (Modal equivalent) */}
      {sheetOpen && (
        <div
          className="absolute inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm"
          onClick={handleClose}
        >
          <div
            className="w-full rounded-t-[28px] bg-[#15151A] px-6 pt-3 pb-10 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-6 h-1 w-12 rounded-full bg-white/20" />

            {submitted === null ? (
              <>
                <h3 className="mb-2 text-2xl font-black">{t("sheetTitle")}</h3>
                <p className="mb-6 text-sm leading-5 text-white/60">
                  {t("sheetDescLine1")}
                  <br />
                  {t("sheetDescLine2")}
                </p>

                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                  <input
                    type="tel"
                    inputMode="numeric"
                    placeholder="010-0000-0000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoFocus
                    className="h-14 rounded-2xl bg-white/5 px-5 text-lg font-semibold text-white placeholder:text-white/30 outline-none focus:bg-white/10"
                  />
                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex h-14 items-center justify-center rounded-full text-base font-bold transition-all active:scale-[0.98] disabled:opacity-60"
                    style={{
                      backgroundColor: event.brandColor,
                      color: event.brandColorFg,
                    }}
                  >
                    {submitting ? t("submitting") : t("submitDone")}
                  </button>
                </form>

                <p className="mt-4 text-center text-[11px] text-white/40">
                  {t("privacyNotice")}
                </p>
              </>
            ) : (
              <div className="flex flex-col items-center gap-1.5 pt-2">
                <span className="text-4xl">🎉</span>
                <p className="text-sm text-white/60">{t("successYouAre")}</p>
                <p
                  className="text-[56px] font-black leading-[60px] tabular-nums"
                  style={{ color: event.brandColor }}
                >
                  #{submitted.toLocaleString()}
                </p>
                <p className="text-sm text-white/60">{t("successFanSuffix")}</p>
                <p className="mt-3 text-center text-base font-bold text-white">
                  {event.title}
                </p>
                <p className="mt-1 text-center text-[12px] text-white/50">
                  {t("successNotifyHint")}
                </p>

                <div className="mt-5 flex gap-3">
                  {["카카오", "스토리", "X"].map((label) => (
                    <button
                      key={label}
                      type="button"
                      className="h-11 min-w-20 rounded-full bg-white/10 px-4 text-xs font-semibold text-white hover:bg-white/20 active:scale-95"
                      onClick={() => alert(t("shareAlert", { label: label ?? "" }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={handleClose}
                  className="mt-5 p-3 text-sm text-white/50"
                >
                  {t("close")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Home indicator */}
      <div className="absolute bottom-2 left-1/2 z-40 h-1 w-32 -translate-x-1/2 rounded-full bg-white/40" />
    </div>
  );
}

function MobileCountdown({
  targetIso,
  accent,
}: {
  targetIso: string;
  accent: string;
}) {
  const t = useTranslations("event.mobilePreview");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const diff = new Date(targetIso).getTime() - now;
  const isLive = diff <= 0;

  if (isLive) {
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-3xl px-8 py-6"
        style={{ backgroundColor: accent }}
      >
        <span className="text-xs font-bold tracking-[0.2em] text-white">
          LIVE
        </span>
        <span className="text-2xl font-black text-white">{t("liveNow")}</span>
      </div>
    );
  }

  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff / 3_600_000) % 24);
  const minutes = Math.floor((diff / 60_000) % 60);
  const seconds = Math.floor((diff / 1000) % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");

  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.25em] text-white/60">
        {t("timeRemaining")}
      </span>
      <div
        className="text-[54px] font-black leading-none tabular-nums"
        style={{
          color: accent,
          textShadow: `0 0 32px ${accent}40`,
          fontFamily: "var(--font-pretendard, Pretendard, sans-serif)",
          letterSpacing: "-0.03em",
        }}
      >
        {days > 0 && <>{pad(days)}{t("dayUnit")} </>}
        {pad(hours)}
        <span className="text-white/30">:</span>
        {pad(minutes)}
        <span className="text-white/30">:</span>
        {pad(seconds)}
      </div>
    </div>
  );
}

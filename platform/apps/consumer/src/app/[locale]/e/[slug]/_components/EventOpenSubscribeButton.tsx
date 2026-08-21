/**
 * EventOpenSubscribeButton — 단일 거대 CTA (Laylo DNA)
 *
 * 페이지 최대 폭 85%, 높이 56px 고정.
 * 클릭 → 바텀시트 → 전화번호 1개 입력 → 즉시 opt-in → 축하 화면.
 *
 * API: POST /api/v1/events/{eventId}/open-subscriptions
 */

"use client";

import { useState } from "react";
import { API_URL } from "@pickket/lib";
import { useTranslations } from "next-intl";

type Props = {
  eventId: string;
  eventTitle: string;
  subscriberCount: number;
};

type SubscribeState =
  | { status: "idle" }
  | { status: "open" }
  | { status: "submitting" }
  | { status: "done"; rank: number };

export function EventOpenSubscribeButton({
  eventId,
  eventTitle,
  subscriberCount,
}: Props) {
  const t = useTranslations("event.openSubscribe");
  const [state, setState] = useState<SubscribeState>({ status: "idle" });
  const [phone, setPhone] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^01[0-9]{8,9}$/.test(phone.replace(/-/g, ""))) {
      alert(t("invalidPhone"));
      return;
    }
    setState({ status: "submitting" });
    try {
      const cleanPhone = phone.replace(/-/g, "");
      const res = await fetch(
        `${API_URL}/api/v1/events/${eventId}/open-subscriptions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: `+82${cleanPhone.slice(1)}`,
            channel: "sms",
          }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        alert(err?.detail ?? t("submitFailed"));
        setState({ status: "open" });
        return;
      }
      const data = await res.json();
      setState({ status: "done", rank: data.subscriber_count });
    } catch {
      alert(t("networkError"));
      setState({ status: "open" });
    }
  }

  if (state.status === "done") {
    return (
      <SubscribeSuccessScreen
        eventTitle={eventTitle}
        rank={state.rank}
        eventId={eventId}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setState({ status: "open" })}
        className="group relative flex h-14 w-[85vw] max-w-md items-center justify-center gap-2 rounded-full text-base font-bold shadow-[0_8px_32px_rgba(0,0,0,0.3)] transition-all active:scale-[0.98]"
        style={{
          background: "var(--event-accent)",
          color: "var(--event-accent-fg)",
        }}
      >
        <span aria-hidden>📱</span>
        <span>{t("ctaButton")}</span>
      </button>

      <p className="text-xs text-white/50">
        {t("subscriberCountBefore")}{" "}
        <strong className="text-white/80">
          {subscriberCount.toLocaleString()}{t("subscriberCountUnit")}
        </strong>
        {t("subscriberCountAfter")}
      </p>

      {state.status !== "idle" && (
        <SubscribeSheet
          phone={phone}
          setPhone={setPhone}
          onClose={() => setState({ status: "idle" })}
          onSubmit={handleSubmit}
          submitting={state.status === "submitting"}
        />
      )}
    </>
  );
}

function SubscribeSheet({
  phone,
  setPhone,
  onClose,
  onSubmit,
  submitting,
}: {
  phone: string;
  setPhone: (v: string) => void;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  submitting: boolean;
}) {
  const t = useTranslations("event.openSubscribe");
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-3xl bg-[#15151A] p-6 pb-10 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-6 h-1 w-12 rounded-full bg-white/20" />
        <h2 className="mb-2 text-2xl font-black">{t("ctaButton")}</h2>
        <p className="mb-6 text-sm text-white/60">
          {t("sheetDescription")}
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
            className="flex h-14 items-center justify-center rounded-full text-base font-bold transition-all active:scale-[0.98] disabled:opacity-50"
            style={{
              background: "var(--event-accent)",
              color: "var(--event-accent-fg)",
            }}
          >
            {submitting ? t("submitting") : t("submitButton")}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-white/40">
          {t("privacyNote")}
        </p>
      </div>
    </div>
  );
}

function SubscribeSuccessScreen({
  eventTitle,
  rank,
  eventId: _eventId,
}: {
  eventTitle: string;
  rank: number;
  eventId: string;
}) {
  const t = useTranslations("event.openSubscribe");
  return (
    <div
      className="flex flex-col items-center gap-4 rounded-3xl px-8 py-10 text-center"
      style={{
        background: "color-mix(in oklab, var(--event-accent) 15%, #0A0A0A)",
        border:
          "1px solid color-mix(in oklab, var(--event-accent) 30%, transparent)",
      }}
    >
      <span className="text-4xl" aria-hidden>
        🎉
      </span>
      <div>
        <p className="text-sm text-white/60">{t("successRankPre")}</p>
        <p
          className="font-black tabular-nums"
          style={{
            fontSize: "clamp(3rem, 10vw, 5rem)",
            letterSpacing: "-0.03em",
            color: "var(--event-accent)",
          }}
        >
          #{rank.toLocaleString()}
        </p>
        <p className="mt-1 text-sm text-white/60">{t("successRankPost")}</p>
      </div>
      <p className="text-base font-semibold">{eventTitle}</p>
      <p className="text-xs text-white/50">
        {t("successNoticeInfo")}
      </p>

      <div className="mt-2 flex gap-3">
        <ShareButton label={t("shareKakao")} />
        <ShareButton label={t("shareStory")} />
        <ShareButton label="X" />
      </div>
    </div>
  );
}

function ShareButton({ label }: { label: string }) {
  const t = useTranslations("event.openSubscribe");
  return (
    <button
      type="button"
      className="flex h-11 min-w-20 items-center justify-center rounded-full bg-white/10 px-4 text-xs font-semibold text-white transition-all hover:bg-white/20 active:scale-95"
      onClick={() => alert(t("sharePrototype", { label: label ?? "" }))}
    >
      {label}
    </button>
  );
}

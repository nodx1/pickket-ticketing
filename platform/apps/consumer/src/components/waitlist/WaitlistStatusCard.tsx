"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Clock,
  Users,
  PartyPopper,
  X,
  CheckCircle2,
  CreditCard,
} from "lucide-react";
import { Button } from "@pickket/ui";
import { formatKRW } from "@pickket/lib";

interface WaitlistStatusCardProps {
  position: number | null;
  totalWaiting: number;
  status:
    | "waiting"
    | "offered"
    | "accepted"
    | "expired"
    | "removed"
    | "error"
    | "joining";
  tierName: string;
  facePrice: number;
  offerDeadline: number | null;
  onLeave: () => void;
  onAccept?: () => void;
  orderId?: string | null;
}

function CountdownTimer({ deadline }: { deadline: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.floor((deadline - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const secs = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const isUrgent = remaining < 180; // 3 minutes

  return (
    <span
      className={`font-mono font-bold text-sm ${
        isUrgent
          ? "text-red-600 dark:text-red-600"
          : "text-emerald-700 dark:text-emerald-600"
      }`}
    >
      {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
    </span>
  );
}

export default function WaitlistStatusCard({
  position,
  totalWaiting,
  status,
  tierName,
  facePrice,
  offerDeadline,
  onLeave,
  onAccept,
  orderId,
}: WaitlistStatusCardProps) {
  const router = useRouter();
  const t = useTranslations("waitlist.statusCard");

  /* ── Offered state: ticket available ─────────────────────────────────── */
  if (status === "offered") {
    return (
      <div className="rounded-2xl border-2 border-emerald-300 dark:border-emerald-600/30 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-600/10 dark:to-emerald-600/5 p-5 animate-in fade-in slide-in-from-top-2 duration-300">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-8 w-8 rounded-xl bg-emerald-500 dark:bg-emerald-600 flex items-center justify-center">
            <PartyPopper className="h-4 w-4 text-white" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-emerald-800 dark:text-emerald-600">
              {t("offered.title")}
            </h4>
            <p className="text-xs text-emerald-600 dark:text-emerald-600/80">
              {tierName}
            </p>
          </div>
          {offerDeadline && (
            <div className="ml-auto flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-600/80" />
              <CountdownTimer deadline={offerDeadline} />
            </div>
          )}
        </div>

        <div className="rounded-xl bg-card/60 px-4 py-3 mb-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-emerald-700 dark:text-emerald-600">
              {t("offered.facePrice")}
            </span>
            <span className="text-sm font-bold text-emerald-800 dark:text-emerald-600 font-tabular">
              {formatKRW(facePrice)}
            </span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs text-emerald-700 dark:text-emerald-600">
              {t("offered.fee")}
            </span>
            <span className="text-sm font-bold text-emerald-600 dark:text-emerald-600/80">
              {t("offered.feeAmount")}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          {orderId ? (
            <Button
              onClick={() => router.push(`/orders/${orderId}`)}
              className="flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm"
            >
              <CreditCard className="h-4 w-4 mr-1.5" />
              {t("offered.goToPayment")}
            </Button>
          ) : (
            <Button
              onClick={() => onAccept?.()}
              className="flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm"
            >
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
              {t("offered.accept")}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={onLeave}
            className="h-10 rounded-xl border-emerald-200 dark:border-emerald-600/20 text-emerald-700 dark:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-600/10 text-sm"
          >
            {t("offered.decline")}
          </Button>
        </div>
      </div>
    );
  }

  /* ── Waiting state ───────────────────────────────────────────────────── */
  const progress =
    position && totalWaiting > 0
      ? Math.max(5, ((totalWaiting - position + 1) / totalWaiting) * 100)
      : 0;

  return (
    <div className="rounded-2xl border border-emerald-200 dark:border-emerald-600/20 bg-emerald-50/50 dark:bg-emerald-600/10 p-4 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-emerald-100 dark:bg-white/10 flex items-center justify-center">
            <Users className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-600/80" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-emerald-800 dark:text-emerald-600">
              {t("waiting.title")}
            </h4>
            <p className="text-2xs text-emerald-600 dark:text-emerald-600/80">
              {tierName}
            </p>
          </div>
        </div>
        <button
          onClick={onLeave}
          className="p-1 rounded-lg hover:bg-emerald-100 dark:hover:bg-white/10 transition-colors"
          aria-label={t("waiting.leaveAriaLabel")}
        >
          <X className="h-3.5 w-3.5 text-emerald-400 dark:text-emerald-600/60" />
        </button>
      </div>

      {/* Position indicator */}
      <div className="flex items-baseline gap-1 mb-2">
        <span className="text-2xl font-bold text-emerald-700 dark:text-emerald-600">
          {position ?? "—"}
        </span>
        <span className="text-xs text-emerald-600 dark:text-emerald-600/80">
          {t("waiting.positionOf", { total: totalWaiting ?? 0 })}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-emerald-100 dark:bg-white/10 rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-emerald-500 dark:bg-emerald-600 rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Info row */}
      <div className="flex items-center justify-between text-xs-plus text-emerald-600 dark:text-emerald-600/80">
        <span className="font-tabular">
          {t("waiting.infoRow", { facePrice: formatKRW(facePrice) })}
        </span>
        <span>{t("waiting.returnNotice")}</span>
      </div>
    </div>
  );
}

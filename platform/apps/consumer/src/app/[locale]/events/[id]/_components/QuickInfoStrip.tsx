"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { MapPin, Calendar, Clock, Dice5, Ticket, Eye } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCountdown } from "../detail-helpers";
import ContentWidth from "@/components/ui/ContentWidth";

interface QuickInfoStripProps {
  title: string;
  venue: string | null;
  date: string;
  biddingClosesAt?: string;
  onCTAClick: () => void;
  status: string;
  minPrice?: number | null;
  category?: string;
}

export function QuickInfoStrip({
  title,
  venue,
  date,
  biddingClosesAt,
  onCTAClick,
  status,
  minPrice,
  category,
}: QuickInfoStripProps) {
  const t = useTranslations("event.quickInfoStrip");
  const countdown = useCountdown(biddingClosesAt ?? "");

  const CTA_LABELS: Record<string, { text: string; icon: typeof Dice5 }> = {
    bidding_open: { text: t("ctaBidding"), icon: Dice5 },
    open: { text: t("ctaBook"), icon: Ticket },
    allocated: { text: t("ctaResult"), icon: Eye },
  };
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const cta = CTA_LABELS[status] ?? { text: t("ctaDefault"), icon: Eye };
  const Icon = cta.icon;

  const formattedDate = new Date(date).toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Seoul",
  });

  return (
    <>
      {/* ──── Static Event Info Bar (below hero, always visible) ──── */}
      <section className="bg-card py-8 md:py-10 border-y border-white/5">
        <ContentWidth className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground/60 text-xs font-bold uppercase tracking-widest">
              {t("labelDate")}
            </span>
            <span className="text-xl md:text-2xl font-bold text-white">
              {formattedDate}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground/60 text-xs font-bold uppercase tracking-widest">
              {t("labelVenue")}
            </span>
            <span className="text-xl md:text-2xl font-bold text-white truncate">
              {venue ?? t("venueUnknown")}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground/60 text-xs font-bold uppercase tracking-widest">
              {t("labelMinPrice")}
            </span>
            <span className="text-xl md:text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {minPrice != null ? t("priceAmount", { amount: minPrice.toLocaleString() }) : t("priceFree")}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground/60 text-xs font-bold uppercase tracking-widest">
              {biddingClosesAt ? t("labelDeadline") : t("labelCategory")}
            </span>
            <span className="text-xl md:text-2xl font-bold text-white">
              {biddingClosesAt ? `D-${countdown.days}` : (category ?? t("categoryDefault"))}
            </span>
          </div>
        </ContentWidth>
      </section>

      {/* ──── Floating sticky bar (appears on scroll) ──── */}
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ y: -48, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -48, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed top-[64px] left-0 right-0 z-40 bg-background/90 backdrop-blur-xl border-b border-white/8 shadow-lg shadow-black/20"
          >
            <ContentWidth className="py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-4 text-sm text-muted-foreground overflow-hidden">
                <span className="font-bold text-white truncate">{title}</span>
                <span className="hidden sm:flex items-center gap-1 shrink-0">
                  <Calendar className="h-3.5 w-3.5" />
                  {formattedDate}
                </span>
                {venue && (
                  <span className="hidden md:flex items-center gap-1 shrink-0">
                    <MapPin className="h-3.5 w-3.5" />
                    {venue}
                  </span>
                )}
                {biddingClosesAt && (
                  <span className="hidden md:flex items-center gap-1 shrink-0 font-tabular text-red-600 dark:text-red-400">
                    <Clock className="h-3.5 w-3.5" />
                    D-{countdown.days}
                  </span>
                )}
              </div>
              <button
                onClick={onCTAClick}
                className="shrink-0 inline-flex items-center gap-1.5 px-5 h-9 rounded-full bg-primary text-white text-xs font-bold shadow-sm hover:brightness-110 transition-all"
              >
                <Icon className="h-3.5 w-3.5" />
                {cta.text}
              </button>
            </ContentWidth>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import Image from "next/image";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Ticket,
  ArrowRight,
  HelpCircle,
} from "lucide-react";
import { Button } from "@pickket/ui";
import type { Event } from "@pickket/lib/api";
import { getCategoryBySlug, blurhashToDataURL } from "@pickket/lib";

interface HeroBannerProps {
  events: Event[];
}

const CATEGORY_GRADIENTS: Record<string, string> = {
  concert: "from-red-500/80 via-pink-600/70 to-purple-700/80",
  musical: "from-teal-500/80 via-emerald-600/70 to-cyan-700/80",
  sports: "from-blue-500/80 via-sky-600/70 to-indigo-700/80",
  classical: "from-green-500/80 via-emerald-600/70 to-teal-700/80",
  exhibition: "from-yellow-500/80 via-amber-600/70 to-orange-700/80",
  festival: "from-purple-500/80 via-fuchsia-600/70 to-pink-700/80",
};

type TFn = ReturnType<typeof useTranslations>;

function getCountdown(closesAt: string, t: TFn): string {
  const now = Date.now();
  const closes = new Date(closesAt).getTime();
  const diff = closes - now;
  if (diff <= 0) return t("closed");
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return t("countdownDaysHours", { days, hours });
  if (hours > 0) return t("countdownHoursMinutes", { hours, minutes });
  return t("countdownMinutes", { minutes });
}

/* ── Branded Hero Fallback — shows when no featured events ────────── */
function BrandedHero() {
  const t = useTranslations("heroBanner");
  return (
    <div className="relative w-full overflow-hidden rounded-2xl">
      <div className="relative min-h-[280px] sm:min-h-[360px] md:min-h-[420px] hero-gradient flex items-center">
        {/* Animated dot pattern overlay */}
        <div className="absolute inset-0 hero-pattern opacity-60" />

        {/* Decorative geometric shapes */}
        <div className="absolute top-10 right-10 w-64 h-64 rounded-full bg-cyan/10 blur-3xl" />
        <div className="absolute bottom-10 left-10 w-48 h-48 rounded-full bg-white/5 blur-2xl" />
        <div className="absolute top-1/2 right-1/4 w-32 h-32 rounded-full border border-white/10 animate-pulse-soft" />
        <div className="absolute bottom-1/4 left-1/3 w-20 h-20 rounded-full border border-cyan/20 animate-float" />

        {/* Content */}
        <div className="relative z-10 w-full max-w-6xl mx-auto px-6 md:px-10 py-12">
          {/* Brand pill */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-6 rounded-full bg-white/10 text-white/90 text-sm font-medium backdrop-blur-sm border border-white/10">
            <Ticket className="h-4 w-4" />
            Pickket &mdash; Fair Ticketing Platform
          </div>

          {/* Main tagline */}
          <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-4 leading-tight max-w-2xl">
            {t("tagline")}
          </h1>

          {/* Subtitle */}
          <p className="text-base sm:text-lg md:text-xl text-white/75 mb-8 max-w-xl leading-relaxed">
            {t("subtitle")}
          </p>

          {/* CTA buttons */}
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/events">
              <Button
                size="lg"
                className="bg-white text-primary hover:bg-white/90 font-semibold text-base px-6 h-12 rounded-xl shadow-lg shadow-black/20"
              >
                {t("browseEvents")}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <Link href="#how-it-works">
              <Button
                size="lg"
                variant="ghost"
                className="text-white/90 hover:text-white hover:bg-white/10 font-medium text-base px-6 h-12 rounded-xl border border-white/20"
              >
                <HelpCircle className="mr-2 h-4 w-4" />
                {t("howItWorks")}
              </Button>
            </Link>
          </div>

          {/* Stats row */}
          <div className="flex flex-wrap items-center gap-6 sm:gap-10 mt-10 pt-8 border-t border-white/10">
            <div>
              <p className="text-2xl sm:text-3xl font-bold text-white">48h</p>
              <p className="text-xs sm:text-sm text-white/60 mt-0.5">
                {t("statBatchWindow")}
              </p>
            </div>
            <div>
              <p className="text-2xl sm:text-3xl font-bold text-cyan">AI</p>
              <p className="text-xs sm:text-sm text-white/60 mt-0.5">
                {t("statFairDist")}
              </p>
            </div>
            <div>
              <p className="text-2xl sm:text-3xl font-bold text-white">0</p>
              <p className="text-xs sm:text-sm text-white/60 mt-0.5">
                {t("statQueueStress")}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Carousel Hero — shows when featured events exist ─────────────── */
export default function HeroBanner({ events }: HeroBannerProps) {
  const t = useTranslations("heroBanner");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const slides = events.slice(0, 5);

  const goToSlide = useCallback(
    (index: number) => {
      if (isTransitioning || slides.length === 0) return;
      setIsTransitioning(true);
      setCurrentIndex(index);
      setTimeout(() => setIsTransitioning(false), 600);
    },
    [isTransitioning, slides.length],
  );

  const goNext = useCallback(() => {
    goToSlide((currentIndex + 1) % slides.length);
  }, [currentIndex, slides.length, goToSlide]);

  const goPrev = useCallback(() => {
    goToSlide((currentIndex - 1 + slides.length) % slides.length);
  }, [currentIndex, slides.length, goToSlide]);

  // Auto-rotate (pause in background tabs)
  useEffect(() => {
    if (slides.length <= 1) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (!timer) timer = setInterval(goNext, 5000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    start();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [slides.length, goNext]);

  // If no events, show the branded fallback
  if (slides.length === 0) {
    return <BrandedHero />;
  }

  return (
    <div className="relative w-full overflow-hidden rounded-2xl shadow-xl">
      {/* Slides */}
      <div className="relative" style={{ minHeight: "280px" }}>
        {slides.map((event, index) => {
          const gradient =
            CATEGORY_GRADIENTS[event.category] ||
            "from-primary/80 via-violet/70 to-cyan/80";
          const cat = getCategoryBySlug(event.category);
          const isActive = index === currentIndex;
          const heroImageUrl = event.image_variants?.webp ?? event.image_url;
          const blurData = blurhashToDataURL(event.blurhash);

          return (
            <div
              key={event.id}
              className={`absolute inset-0 w-full transition-opacity duration-600 ease-in-out ${
                isActive ? "opacity-100 z-10" : "opacity-0 z-0"
              }`}
            >
              <div
                className={`relative min-h-[280px] sm:min-h-[380px] md:min-h-[440px] bg-gradient-to-br ${gradient} flex items-center`}
              >
                {/* Background image if available */}
                {heroImageUrl && (
                  <>
                    <div className="absolute inset-0">
                      <Image
                        src={heroImageUrl}
                        alt={event.title}
                        fill
                        priority={index === 0}
                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 1280px"
                        className="object-cover"
                        {...(blurData
                          ? {
                              placeholder: "blur" as const,
                              blurDataURL: blurData,
                            }
                          : {})}
                      />
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/50 to-black/30" />
                  </>
                )}

                {/* Subtle pattern overlay */}
                <div className="absolute inset-0 hero-pattern opacity-30" />

                <div className="relative z-10 w-full max-w-6xl mx-auto px-6 md:px-10 py-10">
                  {cat && (
                    <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 mb-4 text-xs font-semibold rounded-full bg-white/15 text-white backdrop-blur-md border border-white/10">
                      {cat.label}
                    </span>
                  )}
                  <h2 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-3 line-clamp-2 max-w-xl drop-shadow-lg">
                    {event.title}
                  </h2>
                  <p className="text-white/85 text-sm sm:text-base mb-1 drop-shadow">
                    {event.venue}
                    {event.location_city && ` \u00B7 ${event.location_city}`}
                  </p>
                  <p className="text-white/70 text-sm mb-5">
                    {new Date(event.event_date).toLocaleDateString("ko-KR", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>

                  {/* Countdown with glass-morphism */}
                  {event.status === "bidding_open" && (
                    <div className="inline-flex items-center gap-2 px-4 py-2 mb-5 rounded-xl bg-white/10 text-white text-sm font-medium backdrop-blur-md border border-white/15 shadow-lg">
                      <Clock className="h-4 w-4 text-cyan" />
                      <span>{getCountdown(event.bidding_closes_at, t)}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-3 mt-1">
                    <Link href={`/events/${event.id}`}>
                      <Button
                        size="lg"
                        className="bg-white text-foreground hover:bg-white/90 font-semibold text-base px-6 h-12 rounded-xl shadow-lg shadow-black/20"
                      >
                        {t("applyNow")}
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Navigation arrows */}
      {slides.length > 1 && (
        <>
          <button
            type="button"
            onClick={goPrev}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-20 h-11 w-11 rounded-full bg-black/25 text-white flex items-center justify-center hover:bg-black/45 transition-all backdrop-blur-md border border-white/10"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={goNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-20 h-11 w-11 rounded-full bg-black/25 text-white flex items-center justify-center hover:bg-black/45 transition-all backdrop-blur-md border border-white/10"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </>
      )}

      {/* Dots / Progress */}
      {slides.length > 1 && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 flex gap-2">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goToSlide(i)}
              aria-label={t("slideLabel", { index: i + 1 })}
              aria-current={i === currentIndex ? "true" : undefined}
              className="flex items-center justify-center min-w-[24px] min-h-[24px]"
            >
              <span
                className={`h-2 rounded-full transition-all duration-400 ${
                  i === currentIndex
                    ? "w-8 bg-white shadow-lg"
                    : "w-2 bg-white/40 hover:bg-white/60"
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

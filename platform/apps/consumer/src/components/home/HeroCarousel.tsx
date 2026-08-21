"use client";

import { useEffect, useEffectEvent, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import { ArrowRight, Play, Pause } from "lucide-react";
import type { HomePageEvent } from "./types";
import { fmtPrice } from "./types";
import { SALE_MODE_LABELS } from "@pickket/lib/constants";
import { normalizeSaleMode } from "@pickket/lib";

/* ── Label / highlight / button color configs ── */
const LABEL_COLORS: Record<string, React.CSSProperties> = {
  heroLabelFair: {
    border: "1px solid rgba(5,150,105,0.35)",
    background: "rgba(5,150,105,0.15)",
    color: "#059669",
  },
  heroLabelAccent: {
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(255,255,255,0.08)",
    color: "#e5e7eb",
  },
  heroLabelHot: {
    border: "1px solid rgba(255,107,107,0.3)",
    background: "rgba(255,107,107,0.15)",
    color: "#ff6b6b",
  },
};

const HIGHLIGHT_COLORS: Record<string, React.CSSProperties> = {
  heroHighlightFair: {
    background: "linear-gradient(135deg, #ffffff, #a3a3a3)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  heroHighlightAccent: {
    background: "linear-gradient(135deg, #ffffff, #d4d4d4)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  heroHighlightHot: {
    background: "linear-gradient(135deg, #ff6b6b, #ff9f43)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
};

const BUTTON_COLORS: Record<string, React.CSSProperties> = {
  heroPrimaryFair: {
    background: "linear-gradient(135deg, #0a0a0a, #404040)",
    boxShadow: "0 10px 32px rgba(10,10,10,0.32)",
  },
  heroPrimaryAccent: {
    background: "linear-gradient(135deg, #1a1a1a, #404040)",
    boxShadow: "0 10px 32px rgba(10,10,10,0.32)",
  },
  heroPrimaryHot: {
    background: "linear-gradient(135deg, #ff6b6b, #f97316)",
    boxShadow: "0 10px 32px rgba(255,107,107,0.28)",
  },
};

interface HeroSlide {
  id: string;
  label: string;
  labelClassName: keyof typeof LABEL_COLORS;
  highlightClassName: keyof typeof HIGHLIGHT_COLORS;
  title: string;
  subtitle: string;
  suffix: string;
  description: string;
  ctaLabel: string;
  href: string;
  ghostLabel: string;
  ghostHref: string;
  buttonClassName: keyof typeof BUTTON_COLORS;
  image: string;
  trending: string | null;
}

function useBrandSlides(): HeroSlide[] {
  const t = useTranslations("hero_slides");
  return [
    {
      id: "policy",
      label: t("policy.label"),
      labelClassName: "heroLabelFair",
      highlightClassName: "heroHighlightFair",
      title: t("policy.title"),
      subtitle: t("policy.subtitle"),
      suffix: t("policy.suffix"),
      description: t("policy.description"),
      ctaLabel: t("policy.cta"),
      href: "#manifesto",
      ghostLabel: t("policy.ghost"),
      ghostHref: "/fairness",
      buttonClassName: "heroPrimaryFair",
      image:
        "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=1920&q=80",
      trending: t("policy.trending"),
    },
    {
      id: "fan-request",
      label: t("fan_request.label"),
      labelClassName: "heroLabelHot",
      highlightClassName: "heroHighlightHot",
      title: t("fan_request.title"),
      subtitle: t("fan_request.subtitle"),
      suffix: t("fan_request.suffix"),
      description: t("fan_request.description"),
      ctaLabel: t("fan_request.cta"),
      href: "#fan-requests",
      ghostLabel: t("fan_request.ghost"),
      ghostHref: "#fan-requests",
      buttonClassName: "heroPrimaryHot",
      image:
        "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=1920&q=80",
      trending: t("fan_request.trending"),
    },
  ];
}

function eventToSlide(
  event: HomePageEvent,
  index: number,
  labels: {
    freeLabel: string;
    defaultSaleLabel: string;
    applyNow: string;
    bookNow: string;
    detail: string;
    descTemplate: (venue: string, countdown: string) => string;
    comingSoon: string;
    hotTemplate: (n: string) => string;
  },
): HeroSlide {
  const colorStyles = [
    {
      label: "heroLabelAccent" as const,
      highlight: "heroHighlightAccent" as const,
      button: "heroPrimaryAccent" as const,
    },
    {
      label: "heroLabelHot" as const,
      highlight: "heroHighlightHot" as const,
      button: "heroPrimaryHot" as const,
    },
    {
      label: "heroLabelFair" as const,
      highlight: "heroHighlightFair" as const,
      button: "heroPrimaryFair" as const,
    },
  ];
  const style = colorStyles[index % colorStyles.length];

  const priceLabel =
    event.min_price > 0 ? fmtPrice(event.min_price) : labels.freeLabel;
  const normalizedMode = event.primary_sale_mode
    ? normalizeSaleMode(event.primary_sale_mode)
    : null;
  const saleLabel = normalizedMode
    ? (SALE_MODE_LABELS[normalizedMode]?.label ?? normalizedMode)
    : labels.defaultSaleLabel;

  return {
    id: event.id,
    label: `${event.venue_name} · ${event.event_date_label}`,
    labelClassName: style.label,
    highlightClassName: style.highlight,
    title: event.title,
    subtitle: priceLabel,
    suffix: ` · ${saleLabel}`,
    description: labels.descTemplate(
      event.venue_name,
      event.countdown_label ?? labels.comingSoon,
    ),
    ctaLabel: normalizedMode === "lottery" ? labels.applyNow : labels.bookNow,
    href: `/events/${event.id}`,
    ghostLabel: labels.detail,
    ghostHref: `/events/${event.id}`,
    buttonClassName: style.button,
    image: event.thumbnail_url || "/placeholder.svg",
    trending:
      event.bid_count > 0
        ? labels.hotTemplate(event.bid_count.toLocaleString())
        : null,
  };
}

interface HeroCarouselProps {
  events?: HomePageEvent[];
}

export default function HeroCarousel({ events = [] }: HeroCarouselProps) {
  const brandSlides = useBrandSlides();
  const t = useTranslations("hero_slides");
  const eventLabels = {
    freeLabel: t("event.free"),
    defaultSaleLabel: t("event.default_sale"),
    applyNow: t("event.apply_now"),
    bookNow: t("event.book_now"),
    detail: t("event.detail"),
    comingSoon: t("event.coming_soon"),
    descTemplate: (venue: string, countdown: string) =>
      t("event.description", { venue, countdown }),
    hotTemplate: (n: string) => t("event.hot", { count: n }),
  };
  const eventSlides = events
    .slice(0, 2)
    .map((ev, i) => eventToSlide(ev, i, eventLabels));
  const slides: HeroSlide[] = [...brandSlides, ...eventSlides];
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const rotateSlide = useEffectEvent(() => {
    setActiveIndex((current) => (current + 1) % slides.length);
  });

  useEffect(() => {
    if (isPaused) return;
    const interval = window.setInterval(() => {
      rotateSlide();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [isPaused]);

  const currentSlide = slides[activeIndex];

  return (
    <section
      className="relative overflow-hidden bg-background"
      style={{ height: "92vh", minHeight: 600 }}
    >
      <AnimatePresence initial={false} mode="sync">
        <motion.div
          key={`${currentSlide.id}-bg`}
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: "easeInOut" }}
        >
          {/* Base layer */}
          <div
            className="absolute inset-0 bg-center bg-cover scale-[1.05]"
            style={{
              backgroundImage: `url(${currentSlide.image})`,
              animation: "heroZoom 20s ease-in-out infinite alternate",
            }}
          />
          {/* Overlay layer */}
          <div
            className="absolute inset-0 bg-center bg-cover scale-[1.05] mix-blend-overlay opacity-70"
            style={{
              backgroundImage: `url(${currentSlide.image})`,
              animation: "heroZoom 20s ease-in-out infinite alternate",
            }}
          />
        </motion.div>
      </AnimatePresence>

      {/* Gradient overlays — 인라인으로 확실하게 */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.1) 30%, rgba(0,0,0,0.7) 100%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(0,0,0,0.75) 0%, transparent 60%)",
        }}
      />

      {/* Content */}
      <div className="absolute inset-0 z-2 flex flex-col justify-end pb-24">
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-8">
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={currentSlide.id}
              className="max-w-2xl"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -18 }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            >
              {currentSlide.trending && (
                <div
                  className="inline-flex items-center gap-1.5 mb-5 py-1 px-3 rounded-full text-xs font-bold uppercase tracking-wider text-pk-hot backdrop-blur-sm"
                  style={{
                    border: "1px solid rgba(255,107,107,0.25)",
                    background: "rgba(255,107,107,0.1)",
                    animation: "trendingPulse 2s ease-in-out infinite",
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-pk-hot"
                    style={{ animation: "pulse 1.4s ease-in-out infinite" }}
                  />
                  {currentSlide.trending}
                </div>
              )}

              <div
                className="inline-flex items-center gap-2 w-fit mb-5 py-1.5 px-3.5 rounded-full text-xs font-semibold backdrop-blur-sm"
                style={LABEL_COLORS[currentSlide.labelClassName]}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full bg-current"
                  style={{ animation: "pulse 1.8s ease-in-out infinite" }}
                />
                {currentSlide.label}
              </div>

              <h1
                className="font-black text-white"
                style={{
                  fontSize: "clamp(36px, 5vw, 64px)",
                  lineHeight: 1.1,
                  letterSpacing: "-0.02em",
                  textShadow: "0 2px 16px rgba(0,0,0,0.4)",
                }}
              >
                {currentSlide.title}
                <br />
                <span>
                  <span
                    style={HIGHLIGHT_COLORS[currentSlide.highlightClassName]}
                  >
                    {currentSlide.subtitle}
                  </span>
                  {currentSlide.suffix}
                </span>
              </h1>

              <p
                className="max-w-lg mt-5 text-base leading-relaxed"
                style={{
                  color: "rgba(255,255,255,0.7)",
                  textShadow: "0 1px 4px rgba(0,0,0,0.3)",
                }}
              >
                {currentSlide.description}
              </p>

              <div className="flex items-center gap-3 flex-wrap mt-8">
                <Link
                  href={currentSlide.href}
                  className="inline-flex items-center gap-2 h-12 px-7 rounded-full text-white text-sm font-bold"
                  style={{
                    ...BUTTON_COLORS[currentSlide.buttonClassName],
                    transition: "transform 0.2s",
                  }}
                >
                  {currentSlide.ctaLabel}
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href={currentSlide.ghostHref}
                  className="inline-flex items-center gap-2 h-12 px-7 rounded-full text-sm font-semibold backdrop-blur-sm"
                  style={{
                    color: "rgba(255,255,255,0.8)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.05)",
                    transition: "all 0.2s",
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                  {currentSlide.ghostLabel}
                </Link>
              </div>
            </motion.div>
          </AnimatePresence>

          {/* Indicators — 컨텐츠 바로 아래 */}
          <div className="flex items-center gap-2 mt-10">
            {slides.map((slide, index) => {
              const isActive = index === activeIndex;

              return (
                <button
                  key={slide.id}
                  type="button"
                  aria-label={t("slide_number", { number: index + 1 })}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => setActiveIndex(index)}
                  className="relative border-0 rounded-full cursor-pointer flex items-center justify-center min-w-[24px] min-h-[24px] py-[11px]"
                  style={{
                    width: isActive ? 54 : 40,
                    background: "transparent",
                    transition: "all 0.25s",
                  }}
                >
                  <span
                    className="absolute inset-x-0 h-1 overflow-hidden rounded-full"
                    style={{
                      background: isActive
                        ? "rgba(255,255,255,0.12)"
                        : "rgba(255,255,255,0.18)",
                    }}
                  >
                    {isActive && (
                      <span
                        key={`${slide.id}-${activeIndex}`}
                        className="absolute inset-y-0 left-0 w-full rounded-[inherit]"
                        style={{
                          background: "white",
                          transformOrigin: "left",
                          animation: "dotProgress 5s linear forwards",
                          animationPlayState: isPaused ? "paused" : "running",
                        }}
                      />
                    )}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setIsPaused((p) => !p)}
              aria-label={isPaused ? t("play") : t("pause")}
              className="ml-2 flex h-7 w-7 items-center justify-center rounded-full border-0 cursor-pointer backdrop-blur-sm transition-all"
              style={{
                background: "rgba(255,255,255,0.12)",
                color: "white",
              }}
            >
              {isPaused ? (
                <Play className="h-3 w-3" fill="currentColor" />
              ) : (
                <Pause className="h-3 w-3" fill="currentColor" />
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

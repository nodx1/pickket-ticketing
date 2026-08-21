"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  MapPin,
} from "lucide-react";

import { DEMAND_STYLES, EventItem, fmt } from "@/components/home/types";
import { CATEGORY_LABELS } from "@pickket/lib/constants";

export default function HeroBannerCarousel({
  events,
}: {
  events: EventItem[];
}) {
  const t = useTranslations("home.heroBannerCarousel");
  const [current, setCurrent] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const featured = events.filter((event) => event.isFeatured);

  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setIsTransitioning(true);
      setTimeout(() => {
        setCurrent((prev) => (prev + 1) % featured.length);
        setIsTransitioning(false);
      }, 400);
    }, 5000);
  }, [featured.length]);

  useEffect(() => {
    startTimer();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startTimer]);

  const goTo = (idx: number) => {
    if (idx === current) return;
    setIsTransitioning(true);
    setTimeout(() => {
      setCurrent(idx);
      setIsTransitioning(false);
    }, 300);
    if (timerRef.current) clearInterval(timerRef.current);
    startTimer();
  };

  const prev = () => goTo((current - 1 + featured.length) % featured.length);
  const next = () => goTo((current + 1) % featured.length);

  const event = featured[current];
  const demand = DEMAND_STYLES[event.demand] ?? DEMAND_STYLES.LOW;

  return (
    <section className="relative w-full h-[520px] md:h-[600px] overflow-hidden">
      {featured.map((featuredEvent, index) => (
        <div
          key={featuredEvent.id}
          className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${
            index === current && !isTransitioning ? "opacity-100" : "opacity-0"
          }`}
        >
          <Image
            src={featuredEvent.heroImg}
            alt={featuredEvent.title}
            fill
            priority={index === 0}
            sizes="100vw"
            className="object-cover"
          />
        </div>
      ))}

      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/50 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />

      <div className="relative z-10 h-full w-[min(1200px,calc(100%_-_64px))] mx-auto flex flex-col justify-end pb-24 md:pb-28 pt-20">
        <div
          className={`max-w-[520px] space-y-4 transition-all duration-300 ${
            isTransitioning
              ? "opacity-0 translate-y-2"
              : "opacity-100 translate-y-0"
          }`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-3 py-1 rounded-md bg-white/15 backdrop-blur-sm text-white text-xs font-bold tracking-wide">
              {CATEGORY_LABELS[event.category]}
            </span>
            {event.discount && (
              <span className="px-3 py-1 rounded-md bg-destructive text-white text-xs font-extrabold">
                -{event.discount}% {t("earlyBird")}
              </span>
            )}
            <span
              className={`px-2.5 py-1 rounded-md ${demand.bg} ${demand.text} text-xs-plus font-bold flex items-center gap-1`}
            >
              <Flame className="h-3 w-3" /> {demand.label}
            </span>
          </div>

          <h2 className="text-3xl md:text-5xl font-black text-white leading-[1.15] tracking-tight">
            {event.title}
          </h2>

          {event.artist && (
            <p className="text-white/60 text-sm md:text-base font-medium">
              {event.artist}
            </p>
          )}

          <div className="flex items-center gap-5 text-sm text-white/50">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              {event.date}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5" />
              {event.venue}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-2xl md:text-3xl font-black text-white tabular-nums">
              {fmt(event.price)}원
            </span>
            {event.originalPrice && (
              <span className="text-sm text-white/35 line-through tabular-nums">
                {fmt(event.originalPrice)}원
              </span>
            )}
            {event.timeLeft && (
              <span className="ml-1 px-3 py-1 rounded-full bg-white/10 backdrop-blur-sm text-white/80 text-xs font-medium flex items-center gap-1.5">
                <Clock className="h-3 w-3" /> {event.timeLeft}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Link
              href={`/events/${event.id}`}
              className="px-7 py-3 rounded-full bg-white text-black font-bold text-sm hover:bg-white/90 transition shadow-lg shadow-black/20 inline-flex items-center"
            >
              {t("apply")} <ArrowRight className="inline h-4 w-4 ml-1 -mt-0.5" />
            </Link>
            <Link
              href={`/events/${event.id}`}
              className="px-6 py-3 rounded-full border border-white/25 text-white/90 text-sm font-medium hover:bg-white/10 transition"
            >
              {t("viewDetails")}
            </Link>
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 z-20">
        <div className="w-[min(1200px,calc(100%_-_64px))] mx-auto pb-5 flex items-end justify-between">
          <div className="flex items-center gap-2.5">
            {featured.map((featuredEvent, index) => (
              <button
                key={featuredEvent.id}
                onClick={() => goTo(index)}
                className={`relative overflow-hidden rounded-lg transition-all duration-300 ${
                  index === current
                    ? "w-[100px] h-[60px] md:w-[120px] md:h-[72px] ring-2 ring-white shadow-xl shadow-black/30"
                    : "w-[80px] h-[48px] md:w-[96px] md:h-[58px] opacity-40 hover:opacity-70"
                }`}
              >
                <Image
                  src={featuredEvent.thumbImg}
                  alt={featuredEvent.title}
                  fill
                  sizes="120px"
                  className="object-cover"
                />
                {index === current && (
                  <div className="absolute inset-0 border-2 border-white/60 rounded-lg" />
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={prev}
              className="w-9 h-9 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center text-white/70 hover:bg-white/20 transition"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-1.5">
              {featured.map((featuredEvent, index) => (
                <button
                  key={`featured-dot-${featuredEvent.id}`}
                  onClick={() => goTo(index)}
                  aria-label={t("slideLabel", { index: index + 1 })}
                  aria-current={index === current ? "true" : undefined}
                  className="flex items-center justify-center min-w-[24px] min-h-[24px]"
                >
                  <span
                    className={`rounded-full transition-all duration-300 ${
                      index === current
                        ? "w-7 h-[3px] bg-white"
                        : "w-[3px] h-[3px] bg-white/30 hover:bg-white/50"
                    }`}
                  />
                </button>
              ))}
            </div>
            <button
              onClick={next}
              className="w-9 h-9 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center text-white/70 hover:bg-white/20 transition"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <span className="text-xs-plus text-white/40 tabular-nums font-medium ml-1">
              {current + 1}/{featured.length}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

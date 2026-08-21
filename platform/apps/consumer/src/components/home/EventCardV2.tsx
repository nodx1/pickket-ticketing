"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Calendar, Clock, Heart, MapPin, Star, Users } from "lucide-react";
import { useTranslations } from "next-intl";

import { DEMAND_STYLES, EventItem, fmt } from "@/components/home/types";
import { CATEGORY_LABELS } from "@pickket/lib/constants";

export default function EventCardV2({
  event,
  index,
}: {
  event: EventItem;
  index: number;
}) {
  const [liked, setLiked] = useState(false);
  const [gaugeAnimated, setGaugeAnimated] = useState(false);
  const cardRef = useRef<HTMLAnchorElement>(null);

  const t = useTranslations("event.cardV2");
  const demand = DEMAND_STYLES[event.demand] ?? DEMAND_STYLES.LOW;
  const competitionRate = Math.round((event.bidCount / event.totalSeats) * 100);

  useEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setGaugeAnimated(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <Link
      href={`/events/${event.id}`}
      ref={cardRef}
      className="group relative rounded-2xl overflow-hidden bg-card border border-border hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 cursor-pointer block"
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-muted">
        <Image
          src={event.posterImg}
          alt={event.title}
          fill
          sizes="(max-width: 768px) 50vw, (max-width: 1280px) 33vw, 25vw"
          className="object-cover group-hover:scale-105 transition-transform duration-500"
        />

        {event.discount && (
          <div className="absolute top-3 left-3 px-2.5 py-1 rounded-md bg-destructive text-white text-xs-plus font-extrabold shadow-lg z-10">
            -{event.discount}%
          </div>
        )}

        <div
          className={`absolute top-3 right-3 px-2 py-0.5 rounded-md ${demand.bg} ${demand.text} text-2xs font-bold shadow-lg z-10`}
        >
          {demand.label}
        </div>

        <div className="absolute bottom-3 left-3 z-10">
          <span className="px-2 py-0.5 rounded-md text-2xs font-bold bg-black/50 text-white backdrop-blur-sm">
            {CATEGORY_LABELS[event.category]}
          </span>
        </div>

        {event.timeLeft && (
          <div className="absolute bottom-3 right-3 px-2 py-1 rounded-md bg-black/50 backdrop-blur-sm text-white text-2xs font-medium flex items-center gap-1 z-10">
            <Clock className="h-3 w-3" /> {event.timeLeft}
          </div>
        )}

        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-20 flex items-center justify-center">
          <button className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-bold shadow-xl hover:bg-white/90 transition-colors">
            {t("applyButton")}
          </button>
        </div>
      </div>

      <div className="p-3 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm-minus font-bold text-foreground leading-snug line-clamp-2 group-hover:text-primary transition-colors">
            {event.title}
          </h3>
          <button
            onClick={(eventClick) => {
              eventClick.preventDefault();
              setLiked(!liked);
            }}
            className="shrink-0 mt-0.5"
          >
            <Heart
              className={`h-4 w-4 transition-all ${
                liked
                  ? "fill-red-500 text-red-500"
                  : "text-muted-foreground hover:text-red-400"
              }`}
            />
          </button>
        </div>

        {event.artist && (
          <p className="text-xs-plus text-muted-foreground truncate">
            {event.artist}
          </p>
        )}

        <div className="flex items-center gap-3 text-xs-plus text-muted-foreground">
          <span className="flex items-center gap-1 truncate">
            <MapPin className="h-3 w-3 shrink-0" />
            {event.venue}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            <Calendar className="h-3 w-3" />
            {event.date.split("~")[0].trim()}
          </span>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="text-base font-extrabold text-primary tabular-nums">
            {t("priceWon", { price: fmt(event.price) })}
          </span>
          {event.originalPrice && (
            <span className="text-xs-plus text-muted-foreground line-through tabular-nums">
              {t("priceWon", { price: fmt(event.originalPrice) })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <div className="flex items-center">
            {[1, 2, 3, 4, 5].map((star) => (
              <Star
                key={star}
                className={`h-3 w-3 ${
                  star <= Math.floor(event.rating)
                    ? "fill-amber-400 text-amber-400"
                    : "text-muted-foreground/20"
                }`}
              />
            ))}
          </div>
          <span className="text-xs-plus font-semibold text-foreground">
            {event.rating}
          </span>
          <span className="text-2xs text-muted-foreground">
            ({event.reviewCount})
          </span>
        </div>

        <div>
          <div className="flex items-center justify-between text-2xs mb-0.5">
            <span className="text-muted-foreground">
              <Users className="inline h-3 w-3 mr-0.5 -mt-0.5" />
              {t("bidCount", { count: fmt(event.bidCount) })}
            </span>
            <span
              className={`font-bold ${
                competitionRate > 80
                  ? "text-red-500"
                  : competitionRate > 50
                    ? "text-amber-500"
                    : "text-primary"
              }`}
            >
              {t("competitionRate", { rate: competitionRate ?? 0 })}
            </span>
          </div>
          <div className="h-1 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ease-out ${
                competitionRate > 80
                  ? "bg-red-500"
                  : competitionRate > 50
                    ? "bg-amber-500"
                    : "bg-primary"
              }`}
              style={{
                width: gaugeAnimated
                  ? `${Math.min(100, competitionRate)}%`
                  : "0%",
                transitionDuration: "1s",
                transitionDelay: `${index * 80}ms`,
              }}
            />
          </div>
        </div>
      </div>
    </Link>
  );
}

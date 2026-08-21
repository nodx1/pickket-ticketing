"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  MapPin,
  Calendar,
  Clock,
  Heart,
  Users,
  MessageCircle,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@pickket/ui";
import { Badge } from "@pickket/ui";
import { getStatusLabel } from "@pickket/lib";
import { getCategoryBySlug } from "@pickket/lib";
import { blurhashToDataURL, pickImage } from "@pickket/lib";
import { toggleFavorite, getEvent } from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";
import { useTranslations, useLocale } from "next-intl";
import DemandBadge from "@/components/ui/DemandBadge";
import type { Event } from "@pickket/lib/api";

/* Richer category gradients for image placeholders */
const CATEGORY_IMAGE_GRADIENTS: Record<string, string> = {
  concert: "from-red-400 via-pink-500 to-purple-600",
  musical: "from-teal-400 via-emerald-500 to-cyan-600",
  sports: "from-blue-400 via-sky-500 to-indigo-600",
  classical: "from-green-400 via-emerald-500 to-teal-600",
  exhibition: "from-amber-400 via-yellow-500 to-orange-500",
  festival: "from-purple-400 via-fuchsia-500 to-pink-600",
  education: "from-sky-400 via-blue-500 to-cyan-600",
  civic: "from-teal-400 via-emerald-500 to-green-600",
};

/* Status badge gradient backgrounds */
const STATUS_STYLES: Record<string, string> = {
  bidding_open:
    "bg-gradient-to-r from-primary to-brand-lighter text-white border-0",
  allocated: "bg-gradient-to-r from-cyan to-[#00A88E] text-white border-0",
  completed: "bg-muted text-muted-foreground border-0",
  cancelled: "bg-gradient-to-r from-red-500 to-red-600 text-white border-0",
};

function getStatusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "bidding_open":
      return "default";
    case "allocated":
    case "completed":
      return "secondary";
    case "cancelled":
      return "destructive";
    default:
      return "outline";
  }
}

function getTimeRemainingParts(
  closesAt: string | null | undefined,
): { days?: number; hours: number; minutes: number } | null {
  if (!closesAt) return null;
  const now = new Date().getTime();
  const closes = new Date(closesAt).getTime();
  if (Number.isNaN(closes)) return null;
  const diff = closes - now;
  if (diff <= 0) return null;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return { days, hours: hours % 24, minutes };
  }
  return { hours, minutes };
}

function formatEventDate(dateStr: string, locale: string): string {
  // Intl.DateTimeFormat with KST timezone for locale-aware formatting
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(dateStr));
}

/** 두 시각이 **KST 기준 같은 날**인가. 표시가 KST 이므로 비교도 KST 로 해야 한다
 *  (UTC 로 비교하면 한국 밤 시간대 이벤트가 서로 다른 날로 갈린다). */
function isSameCalendarDay(a: string, b: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(a)) === fmt.format(new Date(b));
}

export default function EventCard({ event }: { event: Event }) {
  const { user } = useAuthStore();
  const t = useTranslations("eventCard");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [isFavorited, setIsFavorited] = useState(false);
  const [favoriteLoading, setFavoriteLoading] = useState(false);
  const [heartPulse, setHeartPulse] = useState(false);

  /* Prefetch event detail data on hover for instant navigation */
  const handleMouseEnter = useCallback(() => {
    queryClient.prefetchQuery({
      queryKey: ["events", event.id],
      queryFn: () => getEvent(event.id).then((r) => r.data),
      staleTime: 5 * 60 * 1000,
    });
  }, [queryClient, event.id]);

  // mounted 후에만 카운트다운 계산 — Date.now() SSR vs client mismatch 방지 (#418).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const timeRemainingParts =
    mounted && event.status === "bidding_open"
      ? getTimeRemainingParts(event.bidding_closes_at)
      : null;

  const timeRemaining = timeRemainingParts
    ? timeRemainingParts.days != null
      ? t("daysHours", {
          days: timeRemainingParts.days,
          hours: timeRemainingParts.hours,
        })
      : t("hoursMinutes", {
          hours: timeRemainingParts.hours,
          minutes: timeRemainingParts.minutes,
        })
    : null;

  const imageGradient =
    CATEGORY_IMAGE_GRADIENTS[event.category] ||
    "from-primary via-violet to-cyan";

  const cat = getCategoryBySlug(event.category);
  const statusStyle = STATUS_STYLES[event.status] || "";
  // 4:3 카드 → thumb 렌디션 우선, 그다음 기존 thumb_md, 최종 image_url.
  const cardImageUrl = pickImage(
    event.image_variants,
    "thumb",
    event.image_variants?.thumb_md ?? event.image_url,
  );
  const blurDataURL = blurhashToDataURL(event.blurhash);
  const competitionPercent =
    event.total_seats > 0
      ? Math.min(100, Math.round((event.bid_count / event.total_seats) * 100))
      : 0;

  const handleFavorite = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user || favoriteLoading) return;

    const previousFavorited = isFavorited;
    setFavoriteLoading(true);
    // Optimistic update
    setIsFavorited(!previousFavorited);
    setHeartPulse(true);
    setTimeout(() => setHeartPulse(false), 400);

    try {
      const res = await toggleFavorite(event.id);
      setIsFavorited(res.data.is_favorited);
    } catch {
      // Revert on error
      setIsFavorited(previousFavorited);
    } finally {
      setFavoriteLoading(false);
    }
  };

  return (
    <Link href={`/events/${event.id}`} onMouseEnter={handleMouseEnter}>
      <div className="transition-transform duration-300 ease-out hover:-translate-y-1.5 active:scale-[0.98]">
        <Card className="h-full overflow-hidden rounded-2xl shadow-lg hover:shadow-xl transition-shadow duration-200 cursor-pointer group border-0">
          {/* Image area */}
          <div
            className={`aspect-[4/3] bg-gradient-to-br ${imageGradient} relative overflow-hidden rounded-xl m-2`}
          >
            {/* Public sector badge */}
            {event.is_public_sector && (
              <span className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-full bg-indigo-600/90 text-white text-2xs font-medium backdrop-blur-sm">
                공공
              </span>
            )}

            {cardImageUrl ? (
              <Image
                src={cardImageUrl}
                alt={event.title}
                fill
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 280px"
                className="object-cover group-hover:scale-105 transition-transform duration-500"
                {...(blurDataURL
                  ? { placeholder: "blur" as const, blurDataURL }
                  : {})}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                {/* Category-based gradient placeholder with letter */}
                <div className="w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center mb-2">
                  <span className="text-3xl font-bold text-white/80">
                    {event.title.charAt(0)}
                  </span>
                </div>
                {cat && (
                  <span className="text-xs text-white/60 font-medium">
                    {cat.label}
                  </span>
                )}
              </div>
            )}

            {/* Demand badge overlay */}
            <div className="absolute top-3 right-3">
              <DemandBadge
                bidCount={event.bid_count}
                totalSeats={event.total_seats}
              />
            </div>

            {/* Time remaining - glass morphism */}
            {timeRemaining && (
              <div
                className="absolute bottom-3 left-3 right-3"
                suppressHydrationWarning
              >
                <div className="glass rounded-xl px-3 py-2 text-xs font-medium flex items-center gap-1.5 text-foreground">
                  <Clock className="h-3.5 w-3.5 text-primary/70 dark:text-[#7B8AD4]" />
                  <span suppressHydrationWarning>
                    {t("timeLeft", { time: timeRemaining })}
                  </span>
                </div>
              </div>
            )}

            {/* Hover CTA overlay */}
            <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-end justify-center pb-6 z-10 rounded-b-xl">
              <span className="px-5 py-2 rounded-full bg-white text-primary/70 text-sm font-semibold shadow-lg">
                {t("viewTickets")}
              </span>
            </div>
          </div>

          <CardContent className="pt-4 pb-5">
            {/* Sports match format: Team vs Team */}
            {event.category === "sports" &&
            event.home_team &&
            event.away_team ? (
              <div className="mb-2">
                <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <span className="truncate">{event.home_team}</span>
                  <span className="text-primary/70 text-xs shrink-0">vs</span>
                  <span className="truncate">{event.away_team}</span>
                  {/* Sports match status badge */}
                  {event.match_status === "live" && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-500 text-white text-2xs font-bold shrink-0">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-white" />
                      </span>
                      LIVE
                    </span>
                  )}
                  {event.match_status === "finished" && (
                    <span className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-2xs font-medium shrink-0">
                      종료
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <h3 className="font-semibold text-xs text-muted-foreground line-clamp-1 group-hover:text-primary/70 transition-colors">
                    {event.title}
                  </h3>
                  {/* Sports sub_category badge */}
                  {event.sub_category && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 text-2xs font-semibold">
                      {event.sub_category}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <>
                <h3 className="font-semibold text-base line-clamp-2 mb-1 group-hover:text-primary/70 transition-colors">
                  {event.title}
                </h3>
                {event.category === "festival" && event.subject_name && (
                  <div className="flex items-center gap-1 text-xs text-primary/80 mb-1">
                    <span className="font-semibold">LINEUP</span>
                    <span className="truncate">{event.subject_name}</span>
                  </div>
                )}
              </>
            )}

            {/* Classical conductor */}
            {event.category === "classical" && event.artist_name && (
              <p className="text-xs text-muted-foreground mb-1 line-clamp-1">
                <span className="text-muted-foreground/60">
                  {t("conductor")}{" "}
                </span>
                {event.artist_name}
              </p>
            )}

            {/* Classical program snippet */}
            {event.category === "classical" &&
              Array.isArray(event.program_data) &&
              event.program_data.length > 0 && (
                <p className="text-xs-plus text-muted-foreground/80 mb-1 line-clamp-1 italic">
                  {event.program_data[0].composer} —{" "}
                  {event.program_data[0].title}
                </p>
              )}

            {/* Musical lead cast */}
            {event.category === "musical" && event.artist_name && (
              <p className="text-xs text-muted-foreground mb-1 line-clamp-1">
                <span className="text-muted-foreground/60">
                  {t("leadCast")}{" "}
                </span>
                {event.artist_name}
              </p>
            )}

            {/* Venue + City */}
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-1">
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {event.venue}
                {event.location_city && ` \u00B7 ${event.location_city}`}
              </span>
            </div>

            {/* Date */}
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-3">
              <Calendar className="h-3.5 w-3.5 shrink-0" />
              <span>{formatEventDate(event.event_date, locale)}</span>
              {/* 레벨2 컷오버(W2-EVT): 옛 go 경로는 단일일 이벤트에 event_date_end 를 null 로
                  보냈지만, go `events.ends_at` 은 NOT NULL 이라 go DB 삭제 시 종료일시가 비가역
                  소실된다. 그래서 이제 **항상** 전파한다. 대신 기간 배지는 "존재하면"이 아니라
                  **시작일과 실제로 다를 때만** 띄운다 — 아니면 단일일 전시/교육/시민 이벤트에
                  "8.1 ~ 8.1 · 1일간"이 뜬다. (스키마를 새로 파는 대신 표시 조건을 바로잡는다.) */}
              {(event.category === "exhibition" ||
                event.category === "education" ||
                event.category === "civic") &&
                event.event_date_end &&
                !isSameCalendarDay(event.event_date, event.event_date_end) && (
                  <>
                    <span className="text-muted-foreground/70">
                      ~{" "}
                      {
                        formatEventDate(event.event_date_end, locale).split(
                          ")",
                        )[0]
                      }
                      )
                    </span>
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 text-2xs font-semibold">
                      {Math.max(
                        1,
                        Math.ceil(
                          (new Date(event.event_date_end).getTime() -
                            new Date(event.event_date).getTime()) /
                            (1000 * 60 * 60 * 24),
                        ),
                      )}
                      일간
                    </span>
                  </>
                )}
            </div>

            {/* Price 카드 제거 — 티켓 플랫폼 표준 (인터파크/예스24 방식). 등급별 가격 차이 큰 경우 단일가 표시는 혼란. 상세 페이지에서 등급별 가격 표시. */}

            {/* Seat availability bar */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs-plus text-muted-foreground">
                  {t("competitionRate", { percent: competitionPercent })}
                </span>
                {competitionPercent >= 80 && (
                  <span className="text-2xs font-semibold text-destructive">
                    {t("highDemand")}
                  </span>
                )}
              </div>
              <div className="h-1.5 bg-border rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    competitionPercent >= 80
                      ? "bg-destructive"
                      : competitionPercent >= 50
                        ? "bg-warning"
                        : "bg-primary"
                  }`}
                  style={{ width: `${competitionPercent}%` }}
                />
              </div>
            </div>

            {/* Bottom bar: status + bid count + favorite */}
            <div className="flex items-center justify-between pt-3 border-t border-border">
              <div className="flex items-center gap-2">
                <Badge
                  variant={getStatusVariant(event.status)}
                  className={`text-2xs ${statusStyle}`}
                >
                  {getStatusLabel(event.status)}
                </Badge>
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {event.bid_count.toLocaleString()}
                </span>
              </div>

              {user && (
                <button
                  type="button"
                  onClick={handleFavorite}
                  className="p-1.5 rounded-full hover:bg-muted transition-colors"
                  aria-label={
                    isFavorited ? t("removeFavorite") : t("addFavorite")
                  }
                >
                  <Heart
                    className={`h-4 w-4 transition-colors ${heartPulse ? "heart-pulse" : ""} ${
                      isFavorited
                        ? "fill-red-500 text-red-500"
                        : "text-muted-foreground hover:text-red-500"
                    }`}
                  />
                </button>
              )}
            </div>

            {/* Community signal */}
            {(event.bid_count > 0 || (event.comment_count ?? 0) > 0) && (
              <div className="flex items-center gap-2 text-2xs text-muted-foreground mt-1.5">
                {event.bid_count > 0 && (
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {event.bid_count}명 참여
                  </span>
                )}
                {(event.comment_count ?? 0) > 0 && (
                  <span className="flex items-center gap-1">
                    <MessageCircle className="h-3 w-3" />
                    {event.comment_count}개 댓글
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Link>
  );
}

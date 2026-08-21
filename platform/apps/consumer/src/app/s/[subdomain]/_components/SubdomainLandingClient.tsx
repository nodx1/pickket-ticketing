"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import {
  Calendar,
  MapPin,
  Clock,
  Users,
  MessageCircle,
  Ticket,
  ShieldCheck,
  Globe,
  ExternalLink,
} from "lucide-react";
import { SubdomainShell } from "./SubdomainShell";
import { PuckRenderer } from "./PuckRenderer";
import { ImmersiveHero } from "@/app/[locale]/events/[id]/_components/ImmersiveHero";
import SocialProofBar from "@/components/event-detail/SocialProofBar";
import { ArtistMessageHero } from "./ArtistMessageHero";
// 상세통합 트랙B U3 — 마켓 상세(EventDetailClient)와 동일 컴포넌트 재사용(공용화).
import { EventContextBanner } from "@/app/[locale]/events/[id]/_components/EventContextBanner";
import { RsvpForm } from "@/app/[locale]/events/[id]/_components/RsvpForm";
import { GroupBookingDialog } from "@/app/[locale]/events/[id]/_components/GroupBookingDialog";
import { EventChatbot } from "@/app/[locale]/events/[id]/_components/EventChatbot";
import { EventGallery } from "@/app/[locale]/events/[id]/_components/EventGallery";

interface EventData {
  id: string;
  title: string;
  description?: string;
  event_date: string;
  event_date_end?: string;
  venue?: string;
  image_url?: string;
  thumbnail_url?: string;
  status?: string;
  category?: string;
  bid_count?: number;
  view_count?: number;
  total_seats?: number;
  min_price?: number;
  max_price?: number;
  artist_name?: string;
  organizer_name?: string;
  location_city?: string;
  duration_minutes?: number;
  age_restriction?: string;
  // 상세통합 트랙B U1 — go 정본. NULL/빈값·false 시 미노출(비파괴).
  age_rating?: string;
  venue_address?: string;
  is_online?: boolean;
  homepage_url?: string;
  seat_type?: string;
  tags?: string[];
  // 상세통합 트랙B U3 — go 정본 부속기능 게이트/데이터. NULL/false 시 미노출(비파괴).
  rsvp_enabled?: boolean;
  group_booking_enabled?: boolean;
  context_banner?: string | null;
  gallery_images?: Array<{ url: string; variants?: Record<string, string> | null }> | null;
  page_theme?: { logoUrl?: string } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page_data?: { content?: any[]; root?: any } | null;
}

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.12 } },
};

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

export function SubdomainLandingClient({ event }: { event: EventData }) {
  const t = useTranslations("event.subdomainLanding");
  const pathname = usePathname();
  const basePath = useMemo(() => {
    const match = pathname.match(/^\/s\/[^/]+/);
    return match ? match[0] : "/s/unknown";
  }, [pathname]);

  const formattedDate = new Date(event.event_date).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  const formattedDateEnd = event.event_date_end
    ? new Date(event.event_date_end).toLocaleDateString("ko-KR", {
        month: "long",
        day: "numeric",
        weekday: "short",
      })
    : null;

  /* If Puck page_data exists with content, render the custom page layout */
  if (
    event.page_data &&
    event.page_data.content &&
    event.page_data.content.length > 0
  ) {
    return (
      <SubdomainShell event={event}>
        {/* U3 컨텍스트 배너 — Puck 커스텀 레이아웃에서도 상단 노출(context_banner 있을 때만) */}
        <EventContextBanner banner={event.context_banner} />
        <div className="max-w-4xl mx-auto px-4 py-8">
          <PuckRenderer data={event.page_data} />
        </div>
        {/* U3 챗봇 팝업 — Puck 레이아웃에서도 부동 버튼으로 노출 */}
        <EventChatbot
          eventTitle={event.title}
          venue={event.venue}
          eventDate={event.event_date}
        />
      </SubdomainShell>
    );
  }

  return (
    <SubdomainShell event={event}>
      {/* U3 컨텍스트 배너 (마켓 상세와 정합) — context_banner 있을 때만 */}
      <EventContextBanner banner={event.context_banner} />

      {/* Hero */}
      <ImmersiveHero
        title={event.title}
        imageUrl={event.image_url}
        category={event.category}
        venue={event.venue}
        city={event.location_city}
        date={event.event_date}
        dateEnd={event.event_date_end}
        minPrice={event.min_price}
        maxPrice={event.max_price}
        status={event.status}
        bidCount={event.bid_count}
      />

      {/* Social Proof */}
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 -mt-4 relative z-10">
        <SocialProofBar
          viewCount={event.view_count ?? 0}
          bidCount={event.bid_count ?? 0}
          totalSeats={event.total_seats ?? 0}
          live
          eventId={event.id}
        />
      </div>

      {/* Artist Messages */}
      <ArtistMessageHero eventId={event.id} />

      {/* U3 RSVP · 단체예약 (마켓 상세와 정합) — 게이트 필드 있을 때만 */}
      {event.rsvp_enabled || event.group_booking_enabled ? (
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 pt-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {event.rsvp_enabled ? (
              <RsvpForm eventId={event.id} eventTitle={event.title} />
            ) : null}
            {event.group_booking_enabled ? (
              <div className="flex items-center">
                <div className="w-full">
                  {/* 화이트라벨 by-subdomain 응답에는 상품(tiers)이 없어 상품선택 미노출.
                      GroupBookingDialog 는 products 비어도 정상 동작(product_id optional). */}
                  <GroupBookingDialog
                    eventId={event.id}
                    eventTitle={event.title}
                    products={[]}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* U3 갤러리 (by-subdomain gallery_images) — 이미지 있을 때만 */}
      {event.gallery_images?.length ? (
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 pt-6">
          <EventGallery images={event.gallery_images} />
        </div>
      ) : null}

      {/* Event Info Section */}
      <motion.div
        className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8"
        variants={stagger}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-40px" }}
      >
        <motion.div
          variants={fadeUp}
          className="rounded-2xl border border-white/5 bg-card p-6 space-y-5"
        >
          <h2 className="text-lg font-bold text-foreground">{t("eventInfo")}</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Date */}
            <div className="flex items-start gap-3">
              <Calendar className="h-5 w-5 text-primary/70 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  {formattedDate}
                  {formattedDateEnd ? ` ~ ${formattedDateEnd}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">{t("dateLabel")}</p>
              </div>
            </div>

            {/* Venue / Online (U1) */}
            {event.is_online ? (
              <div className="flex items-start gap-3">
                <Globe className="h-5 w-5 text-primary/70 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t("onlineEvent")}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("venueLabel")}</p>
                </div>
              </div>
            ) : (
              event.venue && (
                <div className="flex items-start gap-3">
                  <MapPin className="h-5 w-5 text-primary/70 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {event.venue}
                      {event.location_city ? ` · ${event.location_city}` : ""}
                    </p>
                    {event.venue_address?.trim() && (
                      <p className="text-xs text-muted-foreground/90 mt-0.5 break-words">
                        {event.venue_address}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">{t("venueLabel")}</p>
                  </div>
                </div>
              )
            )}

            {/* Duration */}
            {event.duration_minutes && (
              <div className="flex items-start gap-3">
                <Clock className="h-5 w-5 text-primary/70 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t("durationMinutes", { minutes: event.duration_minutes ?? 0 })}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("durationLabel")}</p>
                </div>
              </div>
            )}

            {/* Age Rating — go 정본 age_rating 우선, 없으면 age_restriction 폴백 (U1) */}
            {(event.age_rating?.trim() || event.age_restriction?.trim()) && (
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-primary/70 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {event.age_rating?.trim() || event.age_restriction?.trim()}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("ageRestrictionLabel")}</p>
                </div>
              </div>
            )}

            {/* Official homepage (U1) */}
            {event.homepage_url?.trim() && (
              <div className="flex items-start gap-3">
                <ExternalLink className="h-5 w-5 text-primary/70 shrink-0 mt-0.5" />
                <div>
                  <a
                    href={event.homepage_url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-sm font-medium text-primary hover:underline break-all"
                  >
                    {t("officialHomepage")}
                  </a>
                  <p className="text-xs text-muted-foreground">{t("homepageLabel")}</p>
                </div>
              </div>
            )}
          </div>

          {/* Description */}
          {event.description && (
            <div className="pt-4 border-t border-white/5">
              <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-line">
                {event.description}
              </p>
            </div>
          )}

          {/* Tags */}
          {event.tags && event.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2">
              {event.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-3 py-1 text-xs rounded-full bg-primary/10 text-primary/70 border border-primary/20"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </motion.div>

        {/* Price Info */}
        {(event.min_price != null || event.max_price != null) && (
          <motion.div
            variants={fadeUp}
            className="mt-4 rounded-2xl border border-white/5 bg-card p-6"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t("priceRange")}</span>
              <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                {event.min_price != null ? t("priceWon", { amount: fmt(event.min_price) }) : ""}
                {event.min_price != null &&
                event.max_price != null &&
                event.min_price !== event.max_price
                  ? ` ~ ${t("priceWon", { amount: fmt(event.max_price!) })}`
                  : ""}
              </span>
            </div>
          </motion.div>
        )}

        {/* CTA Buttons */}
        <motion.div
          variants={fadeUp}
          className="mt-8 flex flex-col sm:flex-row gap-4"
        >
          <Link
            href={`${basePath}/community`}
            className="flex-1 flex items-center justify-center gap-2 py-4 rounded-full border-2 border-primary/40 text-primary/70 font-bold text-base hover:bg-primary/10 transition-all active:scale-[0.98]"
          >
            <MessageCircle className="h-5 w-5" />
            {t("joinCommunity")}
          </Link>
          <Link
            href={`${basePath}/tickets`}
            className="flex-1 flex items-center justify-center gap-2 py-4 rounded-full bg-primary text-white font-bold text-base shadow-lg shadow-primary/15 hover:brightness-110 transition-all active:scale-[0.98]"
          >
            <Ticket className="h-5 w-5" />
            {t("bookTickets")}
          </Link>
        </motion.div>

        {/* Organizer & Artist */}
        {(event.organizer_name || event.artist_name) && (
          <motion.div variants={fadeUp} className="mt-6 flex flex-wrap gap-4">
            {event.organizer_name && (
              <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-card px-4 py-3">
                <div className="h-9 w-9 rounded-full bg-white/10 flex items-center justify-center text-sm font-bold text-muted-foreground">
                  {event.organizer_name.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {event.organizer_name}
                  </p>
                  <p className="text-xs-plus text-muted-foreground">{t("organizerLabel")}</p>
                </div>
              </div>
            )}
            {event.artist_name && (
              <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-card px-4 py-3">
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary/70">
                  {event.artist_name.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {event.artist_name}
                  </p>
                  <p className="text-xs-plus text-muted-foreground">{t("artistLabel")}</p>
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* Trust Badges */}
        <motion.div
          variants={fadeUp}
          className="mt-8 flex items-center justify-center gap-6 text-xs-plus text-muted-foreground"
        >
          <span className="flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("trustFairDistribution")}
          </span>
          <span className="flex items-center gap-1">
            <Users className="h-3.5 w-3.5" />{t("trustFanWeighting")}
          </span>
          <span className="flex items-center gap-1">
            <Ticket className="h-3.5 w-3.5" />
            {t("trustFaceValue")}
          </span>
        </motion.div>

        {/* Bottom spacing */}
        <div className="h-8" />
      </motion.div>

      {/* U3 챗봇 팝업 (마켓 상세와 정합) — FAQ 규칙엔진 */}
      <EventChatbot
        eventTitle={event.title}
        venue={event.venue}
        eventDate={event.event_date}
      />
    </SubdomainShell>
  );
}

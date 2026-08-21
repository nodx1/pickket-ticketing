import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { API_URL, BASE_URL, pickImage } from "@pickket/lib";
import type { EventDetail, SeatTier, VenueData } from "@pickket/lib/api";
import EventDetailClient from "./EventDetailClient";

const getEvent = cache(async (id: string): Promise<EventDetail | null> => {
  try {
    const res = await fetch(`${API_URL}/api/v1/events/${id}`, {
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ?? json;
  } catch {
    return null;
  }
});

export const revalidate = 30;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}): Promise<Metadata> {
  const { id, locale } = await params;
  const t = await getTranslations({ locale, namespace: "event.detailHeader" });
  const event = await getEvent(id);

  if (!event) {
    return {
      title: t("notFoundTitle"),
      description: t("notFoundDescription"),
    };
  }

  // seo_metadata (Phase 1-S, go→v2 흡수) 우선 — 없으면 기존 파생 로직으로 폴백.
  const seo = event.seo_metadata ?? null;
  const title = seo?.title?.trim() || event.title;
  const description =
    seo?.description?.trim() ||
    event.summary?.trim() ||
    event.description?.slice(0, 160) ||
    (event.venue
      ? t("defaultDescriptionWithVenue", { venue: event.venue, title })
      : t("defaultDescriptionNoVenue", { title }));
  const keywords = seo?.keywords?.trim() || undefined;
  // OG 1200x630 → seo_metadata.og_image 우선, 그다음 og 렌디션, 마지막 image_url.
  const ogImage =
    seo?.og_image?.trim() ||
    pickImage(event.image_variants, "og", event.image_url);
  const images = ogImage
    ? [{ url: ogImage, width: 1200, height: 630, alt: title }]
    : [];

  return {
    title,
    description,
    ...(keywords ? { keywords } : {}),
    openGraph: {
      title,
      description,
      type: "website",
      url: `${BASE_URL}/events/${event.id}`,
      images,
      siteName: "Pickket",
      locale: "ko_KR",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ogImage ? [ogImage] : [],
    },
  };
}

async function fetchTiers(eventId: string): Promise<SeatTier[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/events/${eventId}/tiers`, {
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) ? json : (json.data ?? []);
  } catch {
    return [];
  }
}

async function fetchVenue(venueId: string): Promise<VenueData | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/venues/${venueId}`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ?? json;
  } catch {
    return null;
  }
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id } = await params;
  const initialEvent = await getEvent(id);
  if (!initialEvent) notFound();

  // SSR에서 tiers + venue 병렬 fetch — 클라이언트 깜빡임 완전 제거
  const venueId =
    typeof initialEvent.venue_id === "string" ? initialEvent.venue_id : null;
  const [initialTiers, initialVenue] = await Promise.all([
    fetchTiers(id),
    venueId ? fetchVenue(venueId) : null,
  ]);

  return (
    <EventDetailClient
      initialEvent={initialEvent}
      initialTiers={initialTiers}
      initialVenue={initialVenue}
    />
  );
}

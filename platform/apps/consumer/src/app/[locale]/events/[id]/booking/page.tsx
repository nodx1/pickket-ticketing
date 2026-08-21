import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { API_URL, BASE_URL } from "@pickket/lib";
import type { EventDetail } from "@pickket/lib/api";
import BookingPageClient from "./BookingPageClient";

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
  const { id } = await params;
  const event = await getEvent(id);

  if (!event) notFound();

  const title = `예매 | ${event.title}`;
  const description =
    event.description?.slice(0, 160) ||
    `${event.venue ? `${event.venue}에서 ` : ""}열리는 ${event.title} 예매`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: `${BASE_URL}/events/${event.id}/booking`,
      siteName: "Pickket",
      locale: "ko_KR",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function BookingPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id } = await params;
  const initialEvent = await getEvent(id);
  if (!initialEvent) notFound();
  return <BookingPageClient initialEvent={initialEvent} />;
}

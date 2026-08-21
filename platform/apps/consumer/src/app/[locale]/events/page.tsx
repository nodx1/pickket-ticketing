import { Suspense } from "react";
import type { Metadata } from "next";
import { API_URL } from "@pickket/lib";
import type { EventSearchResponse } from "@pickket/lib/api";
import EventsClient from "./_components/EventsClient";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "이벤트 | Pickket",
  description:
    "콘서트, 뮤지컬, 스포츠, 페스티벌 등 다양한 이벤트를 공정하게 만나보세요.",
  openGraph: {
    title: "이벤트 | Pickket",
    description:
      "콘서트, 뮤지컬, 스포츠, 페스티벌 등 다양한 이벤트를 공정하게 만나보세요.",
  },
};

async function fetchInitialEvents(
  params: Record<string, string | string[] | undefined>,
): Promise<EventSearchResponse | undefined> {
  try {
    const query = new URLSearchParams();
    query.set("limit", "12");
    query.set("skip", "0");

    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "locale") {
        query.set(key, Array.isArray(value) ? value[0] : value);
      }
    }

    if (!query.has("sort")) query.set("sort", "newest");

    const res = await fetch(`${API_URL}/api/v1/events/search?${query}`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return undefined;

    const data = await res.json();

    // Handle both response shapes: { events, total } or Event[]
    if (Array.isArray(data)) {
      return { events: data, total: data.length };
    }
    return data as EventSearchResponse;
  } catch {
    return undefined;
  }
}

/* ── Loading skeleton ──────────────────────────────────────────────── */

function EventsSkeleton() {
  return (
    <div className="bg-background min-h-screen max-w-7xl mx-auto px-4 sm:px-8 pt-20">
      <div className="mb-8">
        <div className="max-w-2xl mx-auto h-12 bg-white/5 rounded-lg animate-pulse" />
      </div>
      <div className="mb-6">
        <div className="h-8 bg-white/5 rounded animate-pulse w-1/4 mb-2" />
        <div className="h-4 bg-white/5 rounded animate-pulse w-1/6" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl shadow-lg overflow-hidden bg-card"
          >
            <div className="aspect-[4/3] bg-white/5 animate-pulse" />
            <div className="pt-4 pb-5 px-4 space-y-3">
              <div className="h-5 bg-white/5 rounded animate-pulse w-3/4" />
              <div className="h-4 bg-white/5 rounded animate-pulse w-1/2" />
              <div className="h-4 bg-white/5 rounded animate-pulse w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────── */

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialData = await fetchInitialEvents(params);

  return (
    <Suspense fallback={<EventsSkeleton />}>
      <EventsClient initialData={initialData} />
    </Suspense>
  );
}

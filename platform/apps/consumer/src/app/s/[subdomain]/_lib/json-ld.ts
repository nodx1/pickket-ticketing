/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Build Schema.org Event JSON-LD for SEO.
 * @see https://schema.org/Event
 */
export function buildEventJsonLd(event: any) {
  if (!event) return null;

  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.title,
    description: event.description || undefined,
    startDate: event.event_date || undefined,
    endDate: event.event_date_end || undefined,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    image: event.image_url || undefined,
  };

  if (event.venue || event.location_city) {
    jsonLd.location = {
      "@type": "Place",
      name: event.venue || undefined,
      address: event.location_city
        ? { "@type": "PostalAddress", addressLocality: event.location_city }
        : undefined,
    };
  }

  if (event.min_price != null) {
    jsonLd.offers = {
      "@type": "AggregateOffer",
      lowPrice: event.min_price,
      highPrice: event.max_price ?? event.min_price,
      priceCurrency: "KRW",
      availability: "https://schema.org/InStock",
      url: typeof window !== "undefined" ? window.location.href : undefined,
    };
  }

  if (event.organizer_name) {
    jsonLd.organizer = {
      "@type": "Organization",
      name: event.organizer_name,
    };
  }

  if (event.artist_name) {
    jsonLd.performer = {
      "@type": "Person",
      name: event.artist_name,
    };
  }

  return jsonLd;
}

import { BASE_URL } from "@pickket/lib";

/* ── Safe JSON-LD serialization ──────────────────────────────────────
 * JSON.stringify does NOT escape `<`, so user-generated fields (event
 * title/description) containing `</script>` could break out of the
 * application/ld+json block. The strict CSP (nonce-only script-src) already
 * blocks execution, but escape the closing-tag sequence as defense-in-depth.
 */
export function serializeJsonLd(jsonLd: unknown): string {
  return JSON.stringify(jsonLd)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/* ── Event Status → schema.org EventStatusType mapping ──────────────── */
const EVENT_STATUS_MAP: Record<string, string> = {
  draft: "https://schema.org/EventScheduled",
  pending: "https://schema.org/EventScheduled",
  bidding_open: "https://schema.org/EventScheduled",
  bidding_closed: "https://schema.org/EventScheduled",
  allocating: "https://schema.org/EventScheduled",
  allocated: "https://schema.org/EventScheduled",
  open: "https://schema.org/EventScheduled",
  completed: "https://schema.org/EventScheduled",
  postponed: "https://schema.org/EventPostponed",
  cancelled: "https://schema.org/EventCancelled",
};

/* ── Availability mapping ───────────────────────────────────────────── */
function resolveAvailability(
  status: string,
  totalSeats?: number,
  bidCount?: number,
): string {
  if (status === "cancelled") return "https://schema.org/Discontinued";
  if (status === "completed" || status === "allocated")
    return "https://schema.org/SoldOut";
  if (
    totalSeats != null &&
    bidCount != null &&
    totalSeats > 0 &&
    bidCount >= totalSeats
  )
    return "https://schema.org/SoldOut";
  if (status === "bidding_open" || status === "open")
    return "https://schema.org/InStock";
  if (status === "draft" || status === "pending")
    return "https://schema.org/PreOrder";
  return "https://schema.org/InStock";
}

/* ── Category → schema.org performer @type ──────────────────────────── */
function resolvePerformerType(category?: string): string {
  if (!category) return "PerformingGroup";
  const groupTypes = new Set([
    "concert",
    "kpop",
    "festival",
    "esports",
    "sports",
  ]);
  if (groupTypes.has(category)) return "MusicGroup";
  if (category === "classical" || category === "musical")
    return "PerformingGroup";
  return "Person";
}

/* ── Props ──────────────────────────────────────────────────────────── */
export interface EventJsonLdProps {
  /** Event title */
  name: string;
  /** Event description */
  description: string;
  /** ISO 8601 start date */
  startDate: string;
  /** ISO 8601 end date */
  endDate?: string | null;
  /** Venue name */
  location?: string | null;
  /** City (addressLocality) */
  locationCity?: string | null;
  /** Primary image URL */
  image?: string | null;
  /** Canonical URL */
  url: string;
  /** Lowest ticket price */
  lowPrice?: number | null;
  /** Highest ticket price */
  highPrice?: number | null;
  /** Currency code */
  priceCurrency?: string;
  /** Bidding/sale open date (offers.validFrom) */
  validFrom?: string | null;
  /** Internal event status → mapped to schema.org EventStatusType */
  eventStatus?: string;
  /** Total seats capacity */
  totalSeats?: number;
  /** Current bid/purchase count */
  bidCount?: number;
  /** Organizer display name */
  organizerName?: string | null;
  /** Main performer / artist name */
  performerName?: string | null;
  /** Event category (concert, musical, etc.) */
  category?: string | null;
  /** Primary sale mode (fixed_fcfs, lottery, etc.) for x-sale-mode extension */
  primarySaleMode?: string | null;
  /** Duration in minutes */
  durationMinutes?: number | null;
  /** Age restriction label */
  ageRestriction?: string | null;
  /** CSP nonce (unused but kept for compat) */
  nonce?: string;
}

export function EventJsonLd({
  name,
  description,
  startDate,
  endDate,
  location,
  locationCity,
  image,
  url,
  lowPrice,
  highPrice,
  priceCurrency = "KRW",
  validFrom,
  eventStatus = "bidding_open",
  totalSeats,
  bidCount,
  organizerName,
  performerName,
  category,
  primarySaleMode,
  durationMinutes,
  ageRestriction,
  nonce,
}: EventJsonLdProps) {
  /* ── Build location object ─────────────────────────────────────────── */
  const locationObj =
    location || locationCity
      ? {
          "@type": "Place" as const,
          ...(location && { name: location }),
          ...(locationCity && {
            address: {
              "@type": "PostalAddress" as const,
              addressLocality: locationCity,
              addressCountry: "KR",
            },
          }),
        }
      : undefined;

  /* ── Build offers (AggregateOffer) ─────────────────────────────────── */
  const offersObj =
    lowPrice != null
      ? {
          "@type": "AggregateOffer" as const,
          lowPrice,
          highPrice: highPrice ?? lowPrice,
          priceCurrency,
          availability: resolveAvailability(eventStatus, totalSeats, bidCount),
          url,
          ...(validFrom && { validFrom }),
        }
      : undefined;

  /* ── Build performer ───────────────────────────────────────────────── */
  const performerObj = performerName
    ? {
        "@type": resolvePerformerType(category ?? undefined),
        name: performerName,
      }
    : undefined;

  /* ── Build organizer ───────────────────────────────────────────────── */
  const organizerObj = organizerName
    ? {
        "@type": "Organization" as const,
        name: organizerName,
      }
    : undefined;

  /* ── Build duration (ISO 8601 duration) ────────────────────────────── */
  const durationISO =
    durationMinutes != null && durationMinutes > 0
      ? `PT${Math.floor(durationMinutes / 60) > 0 ? `${Math.floor(durationMinutes / 60)}H` : ""}${durationMinutes % 60 > 0 ? `${durationMinutes % 60}M` : ""}`
      : undefined;

  /* ── Assemble JSON-LD ──────────────────────────────────────────────── */
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Event",
    name,
    description,
    startDate,
    ...(endDate && { endDate }),
    eventStatus:
      EVENT_STATUS_MAP[eventStatus] ?? "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    ...(locationObj && { location: locationObj }),
    ...(image && { image: [image] }),
    url,
    ...(offersObj && { offers: offersObj }),
    ...(performerObj && { performer: performerObj }),
    ...(organizerObj && { organizer: organizerObj }),
    ...(durationISO && { duration: durationISO }),
    ...(ageRestriction && { typicalAgeRange: ageRestriction }),
    ...(primarySaleMode && { "x-sale-mode": primarySaleMode }),
  };

  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
    />
  );
}

export function OrganizationJsonLd({ nonce }: { nonce?: string }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Pickket",
    url: BASE_URL,
    logo: `${BASE_URL}/logo.png`,
    description: "특허 기반 공정 티켓 배분 플랫폼",
    sameAs: [],
  };

  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
    />
  );
}

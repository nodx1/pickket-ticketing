/**
 * ResaleEventCardSkeleton
 * Matches ResaleEventCard.tsx layout: 16:9 image area with category badge,
 * title, venue/date row, lowest ask price with sparkline, score + tier count.
 */
export default function ResaleEventCardSkeleton() {
  return (
    <div
      className="rounded-2xl shadow-sm bg-card overflow-hidden"
      aria-busy="true"
      aria-live="polite"
    >
      {/* Image placeholder (16:9) */}
      <div className="relative w-full aspect-[16/9] bg-muted animate-pulse">
        {/* Category badge placeholder */}
        <div className="absolute top-3 left-3">
          <div className="h-5 w-14 bg-muted-foreground/10 rounded-full animate-pulse" />
        </div>
        {/* Listing count badge placeholder */}
        <div className="absolute top-3 right-3">
          <div className="h-5 w-20 bg-muted-foreground/10 rounded-full animate-pulse" />
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* Title */}
        <div className="h-4.5 w-3/4 bg-muted rounded animate-pulse mb-1" />

        {/* Venue + Date row */}
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center gap-1">
            <div className="h-3 w-3 bg-muted rounded animate-pulse" />
            <div className="h-3 w-16 bg-muted rounded animate-pulse" />
          </div>
          <div className="flex items-center gap-1">
            <div className="h-3 w-3 bg-muted rounded animate-pulse" />
            <div className="h-3 w-20 bg-muted rounded animate-pulse" />
          </div>
        </div>

        {/* Price row + sparkline */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="h-2.5 w-14 bg-muted rounded animate-pulse mb-1" />
            <div className="h-5 w-24 bg-muted rounded animate-pulse" />
          </div>
          {/* Mini sparkline placeholder */}
          <div className="h-8 w-16 bg-muted/50 rounded animate-pulse" />
        </div>

        {/* Score + tier count row */}
        <div className="flex items-center justify-between">
          <div className="h-4 w-20 bg-muted rounded animate-pulse" />
          <div className="h-3.5 w-16 bg-muted rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}

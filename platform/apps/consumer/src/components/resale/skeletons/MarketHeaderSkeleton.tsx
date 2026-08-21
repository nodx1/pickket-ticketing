/**
 * MarketHeaderSkeleton
 * Matches MarketHeader.tsx layout: left side (title + price + change),
 * right side (5 stat columns: dayHigh, dayLow, volume, listings, buyOrders).
 */
export default function MarketHeaderSkeleton() {
  return (
    <div
      className="bg-card border-b border-border px-4 py-3 md:px-6 md:py-4"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        {/* Left: Title + Current Price */}
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="h-5 w-40 bg-muted rounded animate-pulse" />
              <div className="h-4 w-12 bg-muted rounded-full animate-pulse" />
              <div className="h-4 w-14 bg-muted rounded-full animate-pulse" />
            </div>
            <div className="flex items-baseline gap-3 mt-1.5">
              <div className="h-7 w-32 bg-muted rounded animate-pulse" />
              <div className="h-4 w-28 bg-muted rounded animate-pulse" />
            </div>
          </div>
        </div>

        {/* Right: 5 Stat columns */}
        <div className="flex items-center gap-4 md:gap-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="text-center space-y-1.5">
              <div className="h-2.5 w-10 bg-muted rounded animate-pulse mx-auto" />
              <div className="h-4 w-16 bg-muted rounded animate-pulse mx-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

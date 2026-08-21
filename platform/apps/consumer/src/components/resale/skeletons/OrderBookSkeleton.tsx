/**
 * OrderBookSkeleton
 * Matches OrderBook.tsx layout: header bar, 3-col labels, 5 ask rows (red tint),
 * spread bar, 5 bid rows (blue tint). Same border-radius, padding, and flex structure.
 */
export default function OrderBookSkeleton() {
  return (
    <div
      className="bg-card rounded-xl border border-border overflow-hidden h-full flex flex-col"
      aria-busy="true"
      aria-live="polite"
    >
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border bg-muted/50">
        <div className="h-3 w-20 bg-muted rounded animate-pulse" />
      </div>

      {/* Column labels */}
      <div className="grid grid-cols-3 px-4 py-1.5 border-b border-border">
        <div className="h-2.5 w-10 bg-muted rounded animate-pulse" />
        <div className="h-2.5 w-10 bg-muted rounded animate-pulse ml-auto" />
        <div className="h-2.5 w-12 bg-muted rounded animate-pulse ml-auto" />
      </div>

      {/* Ask rows (5) -- red tinted bg bars */}
      <div className="flex-1 overflow-hidden min-h-0">
        <div className="flex flex-col justify-end min-h-[180px]">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={`ask-${i}`}
              className="grid grid-cols-3 px-4 py-1 relative"
            >
              <div
                className="absolute inset-y-0 right-0 bg-red-500/[0.06] animate-pulse"
                style={{ width: `${60 - i * 8}%` }}
              />
              <div className="h-3.5 w-16 bg-muted rounded animate-pulse relative z-10" />
              <div className="h-3.5 w-6 bg-muted rounded animate-pulse ml-auto relative z-10" />
              <div className="h-3.5 w-14 bg-muted rounded animate-pulse ml-auto relative z-10" />
            </div>
          ))}
        </div>

        {/* Spread indicator */}
        <div className="px-4 py-2 bg-muted border-y border-border flex items-center justify-between">
          <div className="h-2.5 w-12 bg-muted-foreground/10 rounded animate-pulse" />
          <div className="h-3 w-24 bg-muted-foreground/10 rounded animate-pulse" />
        </div>

        {/* Bid rows (5) -- blue tinted bg bars */}
        <div className="min-h-[180px]">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={`bid-${i}`}
              className="grid grid-cols-3 px-4 py-1 relative"
            >
              <div
                className="absolute inset-y-0 right-0 bg-blue-500/[0.06] animate-pulse"
                style={{ width: `${60 - i * 8}%` }}
              />
              <div className="h-3.5 w-16 bg-muted rounded animate-pulse relative z-10" />
              <div className="h-3.5 w-6 bg-muted rounded animate-pulse ml-auto relative z-10" />
              <div className="h-3.5 w-14 bg-muted rounded animate-pulse ml-auto relative z-10" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

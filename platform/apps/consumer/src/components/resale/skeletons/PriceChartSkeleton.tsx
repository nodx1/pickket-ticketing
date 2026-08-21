/**
 * PriceChartSkeleton
 * Matches PriceChart.tsx layout: header with time-range tabs,
 * 280px chart area with SVG wave placeholder and Y-axis labels.
 */
export default function PriceChartSkeleton() {
  return (
    <div
      className="bg-card rounded-xl border border-border overflow-hidden h-full flex flex-col"
      aria-busy="true"
      aria-live="polite"
    >
      {/* Header with time range tabs */}
      <div className="px-4 py-2.5 border-b border-border bg-muted/50 flex items-center justify-between">
        <div className="h-3 w-16 bg-muted rounded animate-pulse" />
        <div className="flex gap-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-6 w-9 bg-muted rounded-md animate-pulse"
            />
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div className="flex-1 p-3 min-h-[280px] relative">
        {/* Y-axis labels */}
        <div className="absolute left-4 top-3 bottom-3 flex flex-col justify-between py-2 z-10">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-2.5 w-12 bg-muted rounded animate-pulse"
            />
          ))}
        </div>

        {/* SVG wave placeholder */}
        <div className="ml-14 h-full relative overflow-hidden rounded-lg bg-muted/20">
          <svg
            className="absolute inset-0 w-full h-full animate-pulse"
            preserveAspectRatio="none"
            viewBox="0 0 400 200"
          >
            <defs>
              <linearGradient
                id="skeletonGradient"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.08} />
                <stop
                  offset="100%"
                  stopColor="currentColor"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <path
              d="M0,150 Q50,120 100,130 T200,100 T300,110 T400,80 L400,200 L0,200 Z"
              fill="url(#skeletonGradient)"
              className="text-primary"
            />
            <path
              d="M0,150 Q50,120 100,130 T200,100 T300,110 T400,80"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-muted-foreground/20"
            />
          </svg>

          {/* Grid lines */}
          <div className="absolute inset-0 flex flex-col justify-between py-4 pointer-events-none">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="border-t border-dashed border-border/40"
              />
            ))}
          </div>

          {/* X-axis labels at bottom */}
          <div className="absolute bottom-2 left-0 right-0 flex justify-between px-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-2.5 w-10 bg-muted rounded animate-pulse"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

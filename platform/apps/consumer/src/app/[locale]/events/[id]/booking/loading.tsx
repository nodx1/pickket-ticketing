export default function BookingLoading() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header skeleton — matches BookingHeader */}
      <header className="shrink-0 z-40 border-b border-border bg-background">
        <div className="flex items-center justify-between px-5 py-3">
          <div className="flex items-center gap-4 min-w-0">
            {/* Poster thumbnail */}
            <div className="shrink-0 w-10 h-14 rounded-lg bg-muted animate-pulse" />
            {/* Event info */}
            <div className="min-w-0 space-y-1.5">
              <div className="h-5 w-48 rounded bg-muted animate-pulse" />
              <div className="flex items-center gap-3">
                <div className="h-3.5 w-32 rounded bg-muted animate-pulse" />
                <div className="h-3.5 w-24 rounded bg-muted animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Content skeleton — flex layout matching BookingPageClient */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Left: seat map skeleton */}
        <div className="flex-1 min-h-[400px] lg:min-h-[600px] bg-muted/30 animate-pulse" />

        {/* Right: ticket panel skeleton */}
        <div className="w-full lg:w-[420px] shrink-0 border-l-0 lg:border-l border-border space-y-4 p-5">
          {/* Tier list */}
          <div className="rounded-2xl border border-border bg-card/30 p-5 space-y-3">
            <div className="h-4 w-20 rounded bg-muted animate-pulse" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-14 rounded-xl bg-muted/40 animate-pulse"
              />
            ))}
          </div>

          {/* Order summary */}
          <div className="rounded-2xl border border-border bg-card/30 p-5 space-y-3">
            <div className="h-4 w-20 rounded bg-muted animate-pulse" />
            <div className="h-20 rounded-xl bg-muted/30 animate-pulse" />
          </div>

          {/* CTA */}
          <div className="h-14 rounded-2xl bg-muted/40 animate-pulse" />
        </div>
      </div>
    </div>
  );
}

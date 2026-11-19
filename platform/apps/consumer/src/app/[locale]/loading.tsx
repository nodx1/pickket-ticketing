/* ── Homepage skeleton ──────────────────────────────────────────────────── */

const SECTION_W = "max-w-7xl mx-auto px-4 sm:px-8";

function SkeletonEventCard() {
  return (
    <div className="overflow-hidden rounded-2xl bg-card shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
      <div className="aspect-4/3 bg-surface-dim animate-pulse" />
      <div className="p-4 space-y-2.5">
        <div className="h-5 w-3/4 rounded bg-surface-dim animate-pulse" />
        <div className="h-4 w-1/2 rounded bg-surface-dim animate-pulse" />
        <div className="h-4 w-1/3 rounded bg-surface-dim animate-pulse" />
      </div>
    </div>
  );
}

export default function HomeLoading() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-clip">
      {/* 1. HeroCarousel skeleton — matches 92vh / minHeight 600 */}
      <section
        className="relative overflow-hidden bg-surface-dim animate-pulse"
        style={{ height: "92vh", minHeight: 600 }}
      >
        {/* Gradient overlay mimicry */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.1) 30%, rgba(0,0,0,0.7) 100%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, rgba(0,0,0,0.75) 0%, transparent 60%)",
          }}
        />

        {/* Content placeholder — bottom-aligned like real hero */}
        <div className="absolute inset-0 flex flex-col justify-end pb-24">
          <div className="max-w-7xl w-full mx-auto px-4 sm:px-8">
            <div className="max-w-2xl space-y-5">
              {/* Label pill */}
              <div className="h-7 w-56 rounded-full bg-white/10 animate-pulse" />
              {/* Title lines */}
              <div className="space-y-3">
                <div className="h-12 w-full max-w-lg rounded bg-white/15 animate-pulse" />
                <div className="h-12 w-3/4 rounded bg-white/10 animate-pulse" />
              </div>
              {/* Description */}
              <div className="h-5 w-full max-w-md rounded bg-white/8 animate-pulse" />
              {/* CTA buttons */}
              <div className="flex items-center gap-3 mt-3">
                <div className="h-12 w-36 rounded-full bg-white/15 animate-pulse" />
                <div className="h-12 w-32 rounded-full bg-white/8 animate-pulse" />
              </div>
            </div>
            {/* Slide indicators */}
            <div className="flex items-center gap-2 mt-10">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-1 rounded-full bg-white/18 animate-pulse"
                  style={{ width: i === 0 ? 54 : 40 }}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 2. Featured section */}
      <section className={`${SECTION_W} pt-16`}>
        <div className="mb-8 space-y-2">
          <div className="h-4 w-24 rounded bg-surface-dim animate-pulse" />
          <div className="h-9 w-72 rounded bg-surface-dim animate-pulse" />
          <div className="h-4 w-80 rounded bg-surface-dim animate-pulse" />
        </div>
        {/* FeaturedEventCard skeleton */}
        <div className="rounded-2xl overflow-hidden bg-card shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <div className="aspect-21/9 bg-surface-dim animate-pulse" />
          <div className="p-6 space-y-3">
            <div className="h-6 w-2/3 rounded bg-surface-dim animate-pulse" />
            <div className="h-4 w-1/2 rounded bg-surface-dim animate-pulse" />
          </div>
        </div>
      </section>

      {/* 3. Trending Feed section */}
      <section className={`${SECTION_W} pt-16`}>
        <div className="flex items-end justify-between gap-4 mb-8">
          <div className="space-y-2">
            <div className="h-4 w-28 rounded bg-surface-dim animate-pulse" />
            <div className="h-9 w-48 rounded bg-surface-dim animate-pulse" />
            <div className="h-4 w-72 rounded bg-surface-dim animate-pulse" />
          </div>
          <div className="h-10 w-28 rounded-full bg-surface-dim animate-pulse" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonEventCard key={i} />
          ))}
        </div>
      </section>

      {/* 4. Manifesto section skeleton */}
      <section className={`${SECTION_W} pt-16 pb-16`}>
        <div className="mx-auto max-w-2xl text-center space-y-4">
          <div className="mx-auto h-8 w-64 rounded bg-surface-dim animate-pulse" />
          <div className="mx-auto h-4 w-full max-w-lg rounded bg-surface-dim animate-pulse" />
          <div className="mx-auto h-4 w-full max-w-md rounded bg-surface-dim animate-pulse" />
        </div>
      </section>
    </div>
  );
}

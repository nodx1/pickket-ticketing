/* ── Events list page skeleton ──────────────────────────────────────────── */

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] bg-card">
      <div className="aspect-4/3 bg-surface-dim animate-pulse" />
      <div className="p-4 space-y-3">
        <div className="h-5 w-3/4 rounded bg-surface-dim animate-pulse" />
        <div className="space-y-2">
          <div className="h-4 w-1/2 rounded bg-surface-dim animate-pulse" />
          <div className="h-4 w-2/3 rounded bg-surface-dim animate-pulse" />
          <div className="h-4 w-1/3 rounded bg-surface-dim animate-pulse" />
        </div>
        <div className="pt-1">
          <div className="h-9 w-28 rounded-full bg-surface-dim animate-pulse" />
        </div>
      </div>
    </div>
  );
}

export default function EventsLoading() {
  return (
    <div className="bg-background min-h-screen max-w-6xl mx-auto px-5 pt-20 lg:px-6">
      {/* Search bar skeleton */}
      <div className="mb-8">
        <div className="max-w-2xl mx-auto h-12 rounded-lg bg-surface-dim animate-pulse" />
      </div>

      {/* Header skeleton */}
      <div className="mb-6">
        <div className="h-8 w-32 rounded bg-surface-dim animate-pulse mb-2" />
        <div className="h-4 w-24 rounded bg-surface-dim animate-pulse" />
      </div>

      {/* Filter pills skeleton */}
      <div className="space-y-3 mb-8">
        <div className="flex flex-wrap items-center gap-2">
          {/* Category pill skeletons */}
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={`cat-${i}`}
              className="h-10 rounded-full bg-surface-dim animate-pulse"
              style={{ width: `${60 + Math.random() * 30}px` }}
            />
          ))}
          {/* Divider */}
          <div className="w-px h-6 bg-border mx-1" />
          {/* Dropdown pill skeletons */}
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={`filter-${i}`}
              className="h-10 w-24 rounded-full bg-surface-dim animate-pulse"
            />
          ))}
        </div>
      </div>

      {/* View toggle skeleton */}
      <div className="flex items-center justify-end gap-1 mb-6">
        <div className="flex items-center gap-1 rounded-full bg-surface-dim animate-pulse p-1 w-20 h-10" />
      </div>

      {/* Event cards grid skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>

      {/* Load more button skeleton */}
      <div className="flex justify-center mt-10">
        <div className="h-10 w-44 rounded-full bg-surface-dim animate-pulse" />
      </div>
    </div>
  );
}

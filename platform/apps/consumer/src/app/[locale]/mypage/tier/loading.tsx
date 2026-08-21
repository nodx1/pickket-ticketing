export default function TierLoading() {
  return (
    <div className="min-h-screen bg-background p-5 lg:p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Title */}
        <div className="h-8 w-36 bg-muted rounded animate-pulse" />

        {/* Hero card */}
        <div className="bg-card rounded-2xl border border-border p-6 space-y-4">
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 bg-muted rounded-2xl animate-pulse" />
            <div className="space-y-2 flex-1">
              <div className="h-6 w-24 bg-muted rounded animate-pulse" />
              <div className="h-4 w-32 bg-muted rounded animate-pulse" />
            </div>
          </div>
          <div className="h-3 bg-muted rounded-full animate-pulse" />
          <div className="h-4 w-40 bg-muted rounded animate-pulse" />
        </div>

        {/* Tier steps */}
        <div className="flex justify-between">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
              <div className="h-3 w-12 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* Benefits */}
        <div className="space-y-3">
          <div className="h-5 w-24 bg-muted rounded animate-pulse" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-card rounded-xl border border-border p-4 space-y-2">
              <div className="h-4 bg-muted rounded animate-pulse w-1/3" />
              <div className="h-3 bg-muted rounded animate-pulse w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

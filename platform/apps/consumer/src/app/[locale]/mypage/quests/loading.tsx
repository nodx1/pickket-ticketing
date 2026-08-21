export default function QuestsLoading() {
  return (
    <div className="min-h-screen bg-background p-5 lg:p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Title */}
        <div className="h-8 w-28 bg-muted rounded animate-pulse" />

        {/* Attendance card */}
        <div className="bg-card rounded-2xl border border-border p-5 space-y-4">
          <div className="h-5 w-32 bg-muted rounded animate-pulse" />
          <div className="flex justify-between">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-10 w-10 bg-muted rounded-full animate-pulse" />
            ))}
          </div>
          <div className="h-10 bg-muted rounded-full animate-pulse" />
        </div>

        {/* Quest sections */}
        {Array.from({ length: 2 }).map((_, s) => (
          <div key={s} className="space-y-3">
            <div className="h-5 w-24 bg-muted rounded animate-pulse" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
                <div className="h-10 w-10 bg-muted rounded-xl animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-muted rounded animate-pulse w-2/3" />
                  <div className="h-3 bg-muted rounded animate-pulse w-1/3" />
                </div>
                <div className="h-6 w-16 bg-muted rounded-full animate-pulse" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

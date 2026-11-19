export default function MyPageLoading() {
  return (
    <div className="bg-background min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6 px-4 sm:px-8 pb-5 pt-20">
        {/* Profile Hero Card */}
        <div className="rounded-2xl bg-background border border-border/50 shadow-sm p-5 lg:p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 rounded-full bg-muted animate-pulse" />
              <div className="space-y-2">
                <div className="h-7 w-36 bg-muted rounded animate-pulse" />
                <div className="h-4 w-48 bg-muted rounded animate-pulse" />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-1.5">
                <div className="h-6 w-6 bg-muted rounded animate-pulse" />
                <div className="h-9 w-16 bg-muted rounded animate-pulse" />
              </div>
              <div className="h-3 w-16 bg-muted rounded animate-pulse" />
              <div className="h-6 w-20 bg-muted rounded-full animate-pulse mt-0.5" />
            </div>
          </div>
        </div>

        {/* Pill Tab Navigation */}
        <div className="flex gap-1 bg-muted rounded-full p-1 w-fit">
          {[20, 16, 16, 16, 16].map((w, i) => (
            <div
              key={i}
              className="h-10 rounded-full bg-card animate-pulse"
              style={{ width: `${w * 4 + 40}px` }}
            />
          ))}
        </div>

        {/* Quick links */}
        <div className="flex gap-2">
          <div className="h-8 w-24 bg-muted rounded-full animate-pulse" />
        </div>

        {/* Tab Content Area */}
        <div className="rounded-2xl bg-background border border-border/50 shadow-sm p-5 lg:p-6 space-y-4">
          <div className="h-6 w-40 bg-muted rounded animate-pulse" />
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-4 bg-muted rounded animate-pulse w-32" />
                <div className="h-2 bg-muted rounded-full animate-pulse" />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-background border border-border/50 shadow-sm p-5 lg:p-6">
          <div className="h-40 bg-muted rounded-2xl animate-pulse" />
        </div>
      </div>
    </div>
  );
}

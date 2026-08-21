export default function AdminGlobalLoading() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* KPI Cards skeleton */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-card p-5 h-[110px] animate-pulse"
          >
            <div className="h-3 w-16 bg-muted rounded mb-3" />
            <div className="h-6 w-24 bg-muted rounded" />
          </div>
        ))}
      </div>
      {/* Tasks bar */}
      <div className="rounded-lg border border-border bg-card p-5 h-[80px] animate-pulse">
        <div className="h-4 w-24 bg-muted rounded mb-3" />
        <div className="flex gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 w-36 bg-muted rounded-lg" />
          ))}
        </div>
      </div>
      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-lg border border-border bg-card p-5 h-[280px] animate-pulse">
          <div className="h-4 w-36 bg-muted rounded mb-4" />
          <div className="h-[220px] bg-muted/50 rounded" />
        </div>
        <div className="rounded-lg border border-border bg-card p-5 h-[280px] animate-pulse">
          <div className="h-4 w-24 bg-muted rounded mb-4" />
          <div className="h-[220px] bg-muted/50 rounded" />
        </div>
      </div>
    </div>
  );
}

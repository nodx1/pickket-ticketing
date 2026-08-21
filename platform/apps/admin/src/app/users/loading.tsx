export default function UsersLoading() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div className="h-7 w-28 bg-muted rounded animate-pulse" />
        <div className="flex gap-2">
          <div className="h-9 w-40 bg-muted rounded animate-pulse" />
          <div className="h-9 w-24 bg-muted rounded-full animate-pulse" />
        </div>
      </div>
      {/* User table skeleton */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3 animate-pulse">
          <div className="flex gap-6">
            {[80, 120, 100, 60, 80].map((w, i) => (
              <div key={i} className="h-4 bg-muted rounded" style={{ width: w }} />
            ))}
          </div>
        </div>
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <div key={i} className="border-b border-border/60 last:border-0 px-4 py-3 animate-pulse">
            <div className="flex items-center gap-6">
              <div className="h-8 w-8 rounded-full bg-muted" />
              <div className="h-4 w-28 bg-muted rounded" />
              <div className="h-4 w-36 bg-muted rounded" />
              <div className="h-5 w-16 bg-muted rounded-full" />
              <div className="h-4 w-20 bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

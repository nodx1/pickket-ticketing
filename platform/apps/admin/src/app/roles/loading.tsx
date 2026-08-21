export default function RolesLoading() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div className="h-7 w-24 bg-muted rounded animate-pulse" />
        <div className="h-9 w-28 bg-muted rounded-full animate-pulse" />
      </div>
      {/* Role cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-card p-5 animate-pulse"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-lg bg-muted" />
              <div className="space-y-1.5">
                <div className="h-4 w-20 bg-muted rounded" />
                <div className="h-3 w-32 bg-muted rounded" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3].map((j) => (
                <div key={j} className="h-5 w-16 bg-muted rounded-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BadgesLoading() {
  return (
    <div className="min-h-screen bg-background p-5 lg:p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Title */}
        <div className="h-8 w-28 bg-muted rounded animate-pulse" />

        {/* Stats card */}
        <div className="bg-card rounded-2xl border border-border p-5 space-y-3">
          <div className="h-5 w-24 bg-muted rounded animate-pulse" />
          <div className="h-3 bg-muted rounded-full animate-pulse" />
          <div className="h-4 w-20 bg-muted rounded animate-pulse" />
        </div>

        {/* Category pills */}
        <div className="flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 w-16 bg-muted rounded-full animate-pulse" />
          ))}
        </div>

        {/* Badge grid */}
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div className="h-16 w-16 bg-muted rounded-2xl animate-pulse" />
              <div className="h-3 w-14 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

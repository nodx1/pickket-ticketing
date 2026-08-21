export function OpeningSoonSkeleton() {
  return (
    <section className="py-10">
      <div className="max-w-7xl mx-auto px-4 md:px-10 lg:px-16 space-y-6">
        <div className="flex items-center gap-2.5 animate-pulse">
          <div className="h-6 w-6 bg-muted rounded" />
          <div className="h-6 bg-muted rounded w-32" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-2xl overflow-hidden">
              <div className="bg-muted aspect-[4/3] rounded-xl m-2" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-muted rounded w-3/4" />
                <div className="h-3 bg-muted rounded w-1/2" />
                <div className="h-3 bg-muted rounded w-1/3" />
                <div className="h-5 bg-muted rounded w-1/4 mt-2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

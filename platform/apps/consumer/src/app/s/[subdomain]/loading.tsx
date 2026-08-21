export default function SubdomainLoading() {
  return (
    <main className="animate-pulse">
      {/* Hero skeleton */}
      <div className="relative h-[50vh] w-full bg-card" />

      {/* Content skeleton */}
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        {/* Title */}
        <div className="h-8 w-2/3 rounded-lg bg-card" />
        {/* Subtitle */}
        <div className="h-5 w-1/2 rounded-lg bg-card" />

        {/* Info cards */}
        <div className="grid grid-cols-2 gap-4 pt-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-card" />
          ))}
        </div>

        {/* CTA buttons */}
        <div className="flex gap-4 pt-4">
          <div className="h-12 flex-1 rounded-xl bg-card" />
          <div className="h-12 flex-1 rounded-xl bg-card" />
        </div>
      </div>
    </main>
  );
}

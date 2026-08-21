export function BentoGridSkeleton() {
  return (
    <section className="py-10 section-alt">
      <div className="max-w-7xl mx-auto px-4 md:px-10 lg:px-16">
        <div className="flex items-center gap-3 mb-6 animate-pulse">
          <div className="h-7 bg-muted rounded w-48" />
        </div>
        <div className="grid grid-cols-2 gap-3 h-[300px] md:grid-cols-4 md:grid-rows-2 md:h-[420px] animate-pulse">
          <div className="bg-muted rounded-2xl col-span-1 md:col-span-2 md:row-span-2" />
          <div className="bg-muted rounded-2xl col-span-1 md:col-span-2 md:row-span-1" />
          <div className="bg-muted rounded-2xl hidden md:block md:col-span-1 md:row-span-1" />
          <div className="bg-muted rounded-2xl hidden md:block md:col-span-1 md:row-span-1" />
        </div>
      </div>
    </section>
  );
}

export function HeroSkeleton() {
  return (
    <section className="pt-14 pb-10">
      <div className="max-w-7xl mx-auto px-4 md:px-10 lg:px-16 text-center animate-pulse">
        <div className="h-12 bg-muted rounded-lg w-2/3 mx-auto" />
        <div className="h-5 bg-muted rounded w-1/3 mx-auto mt-4" />
        <div className="h-12 bg-muted rounded-xl w-full max-w-lg mx-auto mt-8" />
      </div>
    </section>
  );
}

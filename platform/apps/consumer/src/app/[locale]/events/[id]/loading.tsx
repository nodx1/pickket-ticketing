/* ── Event detail page skeleton — matches EventDetailClient layout ───── */

const CW = { width: "min(1200px, calc(100% - 64px))" } as const;
const CARD_SHELL =
  "rounded-2xl bg-background border border-border/50 shadow-sm overflow-hidden";

/** CollapsibleCard skeleton (icon + title + chevron) */
function CardSkeleton({
  span = "half",
  contentHeight = "h-32",
}: {
  span?: "full" | "half";
  contentHeight?: string;
}) {
  return (
    <div className={`${CARD_SHELL} ${span === "full" ? "col-span-full" : ""}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="h-8 w-8 rounded-lg bg-muted animate-pulse shrink-0" />
        <div className="h-4 w-20 rounded bg-muted animate-pulse" />
        <div className="ml-auto h-4 w-4 rounded bg-muted/40 animate-pulse" />
      </div>
      {/* Content */}
      <div className="border-t border-border px-5 py-5">
        <div
          className={`${contentHeight} rounded-xl bg-muted/30 animate-pulse`}
        />
      </div>
    </div>
  );
}

export default function EventDetailLoading() {
  return (
    <div className="min-h-screen bg-background">
      {/* ═══ 1. ImmersiveHero — full-width image with gradient ═══ */}
      <div
        className="relative w-full"
        style={{ height: "85vh", minHeight: 500 }}
      >
        <div className="absolute inset-0 bg-muted animate-pulse" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />

        {/* Bottom content overlay */}
        <div
          className="absolute bottom-0 left-0 right-0 pb-8 lg:pb-10"
          style={{ paddingInline: "max(32px, calc((100% - 1200px) / 2))" }}
        >
          <div className="flex flex-col gap-3">
            {/* Category badge */}
            <div className="h-6 w-16 rounded-full bg-white/10 animate-pulse" />
            {/* Title */}
            <div className="h-9 w-3/5 max-w-md rounded bg-white/10 animate-pulse" />
            {/* Meta row: date + venue */}
            <div className="flex items-center gap-4">
              <div className="h-4 w-36 rounded bg-white/10 animate-pulse" />
              <div className="h-4 w-28 rounded bg-white/10 animate-pulse" />
            </div>
            {/* Price + CTA */}
            <div className="flex items-center gap-4 mt-3">
              <div className="h-8 w-28 rounded bg-white/10 animate-pulse" />
              <div className="h-12 w-40 rounded-2xl bg-white/15 animate-pulse" />
            </div>
          </div>
        </div>
      </div>

      {/* ═══ 2. SocialProofBar ═══ */}
      <div className="mx-auto -mt-2 pb-4" style={CW}>
        <div className="flex items-center gap-4 px-4 py-3 rounded-2xl bg-muted/20 border border-border/30 animate-pulse">
          <div className="h-3 w-20 rounded bg-muted/40" />
          <div className="h-4 w-px bg-muted/30" />
          <div className="h-3 w-24 rounded bg-muted/40" />
          <div className="h-4 w-px bg-muted/30" />
          <div className="h-3 w-20 rounded bg-muted/40" />
        </div>
      </div>

      {/* ═══ 3. Tier cards grid + CTA ═══ */}
      <div className="mx-auto py-6" style={CW}>
        <div className="space-y-4">
          {/* Desktop: 3-column tier cards */}
          <div className="hidden lg:grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl border border-border/50 bg-background p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                  <div className="h-5 w-14 rounded-full bg-muted/60 animate-pulse" />
                </div>
                <div className="h-7 w-28 rounded bg-muted animate-pulse" />
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-muted animate-pulse" />
                  <div className="h-3 w-14 rounded bg-muted/40 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
          {/* Mobile: horizontal rail */}
          <div className="lg:hidden flex gap-3 overflow-hidden">
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                className="min-w-[200px] h-24 rounded-2xl bg-muted/30 animate-pulse"
              />
            ))}
          </div>
          {/* CTA button */}
          <div className="h-14 rounded-2xl bg-muted/40 animate-pulse" />
        </div>
      </div>

      {/* ═══ 4. BentoGrid — CollapsibleCard sections ═══ */}
      <div className="mx-auto py-6 flex flex-col gap-4" style={CW}>
        {/* 공연 정보 */}
        <CardSkeleton span="full" contentHeight="h-40" />
        {/* 좌석 배치도 */}
        <CardSkeleton span="full" contentHeight="h-52" />
        {/* 출연진 */}
        <CardSkeleton contentHeight="h-28" />
        {/* 커뮤니티 */}
        <CardSkeleton span="full" contentHeight="h-36" />
        {/* 리뷰 */}
        <CardSkeleton span="full" contentHeight="h-28" />
      </div>

      {/* ═══ 5. Mobile sticky bottom ═══ */}
      <div className="fixed bottom-0 left-0 right-0 lg:hidden z-30 bg-background/90 backdrop-blur-2xl border-t border-border">
        <div className="h-0.5 w-full bg-border">
          <div className="h-full w-1/3 bg-muted animate-pulse" />
        </div>
        <div
          className="flex items-center justify-between px-4 py-3.5"
          style={CW}
        >
          <div className="space-y-1">
            <div className="h-5 w-24 rounded bg-muted animate-pulse" />
            <div className="h-3 w-32 rounded bg-muted/40 animate-pulse" />
          </div>
          <div className="h-12 w-28 rounded-full bg-muted animate-pulse" />
        </div>
      </div>
    </div>
  );
}

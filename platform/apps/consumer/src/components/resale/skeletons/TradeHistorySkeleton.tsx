/**
 * TradeHistorySkeleton
 * Matches TradeHistory.tsx layout: header bar, 3-col labels (time / price / fee),
 * 8 trade rows in a scrollable area.
 */
export default function TradeHistorySkeleton() {
  return (
    <div
      className="bg-card rounded-xl border border-border overflow-hidden h-full flex flex-col"
      aria-busy="true"
      aria-live="polite"
    >
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border bg-muted/50">
        <div className="h-3 w-24 bg-muted rounded animate-pulse" />
      </div>

      {/* Column labels */}
      <div className="grid grid-cols-3 px-4 py-1.5 border-b border-border">
        <div className="h-2.5 w-8 bg-muted rounded animate-pulse" />
        <div className="h-2.5 w-10 bg-muted rounded animate-pulse ml-auto" />
        <div className="h-2.5 w-10 bg-muted rounded animate-pulse ml-auto" />
      </div>

      {/* Trade rows (8) */}
      <div className="flex-1 overflow-hidden min-h-0 max-h-[300px]">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-3 px-4 py-1.5"
          >
            <div className="h-3.5 w-16 bg-muted rounded animate-pulse" />
            <div className="h-3.5 w-14 bg-muted rounded animate-pulse ml-auto" />
            <div className="h-3.5 w-14 bg-muted rounded animate-pulse ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

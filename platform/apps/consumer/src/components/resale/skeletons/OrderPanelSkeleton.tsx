/**
 * OrderPanelSkeleton
 * Matches OrderPanel.tsx layout: buy/sell tab header, price input with label,
 * quantity input with -/+ buttons, fee breakdown area, submit button, info text.
 */
export default function OrderPanelSkeleton() {
  return (
    <div
      className="bg-card rounded-xl border border-border overflow-hidden h-full flex flex-col"
      aria-busy="true"
      aria-live="polite"
    >
      {/* Tab Header */}
      <div className="flex border-b border-border">
        <div className="flex-1 py-3 flex justify-center">
          <div className="h-4 w-12 bg-blue-500/15 rounded animate-pulse" />
        </div>
        <div className="flex-1 py-3 flex justify-center">
          <div className="h-4 w-12 bg-muted rounded animate-pulse" />
        </div>
      </div>

      {/* Form area */}
      <div className="p-4 flex-1 flex flex-col gap-4">
        {/* Price input */}
        <div>
          <div className="h-3 w-20 bg-muted rounded animate-pulse mb-1.5" />
          <div className="h-10 w-full bg-muted rounded-lg animate-pulse" />
          <div className="h-2.5 w-32 bg-muted rounded animate-pulse mt-1" />
        </div>

        {/* Quantity input */}
        <div>
          <div className="h-3 w-12 bg-muted rounded animate-pulse mb-1.5" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-muted rounded-lg animate-pulse" />
            <div className="flex-1 h-8 bg-muted rounded-lg animate-pulse" />
            <div className="w-8 h-8 bg-muted rounded-lg animate-pulse" />
          </div>
        </div>

        {/* Fee breakdown placeholder */}
        <div className="rounded-lg bg-muted/50 p-3 space-y-2">
          <div className="flex justify-between">
            <div className="h-3 w-16 bg-muted rounded animate-pulse" />
            <div className="h-3 w-20 bg-muted rounded animate-pulse" />
          </div>
          <div className="flex justify-between">
            <div className="h-3 w-20 bg-muted rounded animate-pulse" />
            <div className="h-3 w-16 bg-muted rounded animate-pulse" />
          </div>
          <div className="border-t border-border pt-2 flex justify-between">
            <div className="h-3.5 w-14 bg-muted rounded animate-pulse" />
            <div className="h-3.5 w-24 bg-muted rounded animate-pulse" />
          </div>
        </div>

        {/* Submit button */}
        <div className="mt-auto pt-2">
          <div className="h-11 w-full bg-blue-600/20 rounded-lg animate-pulse" />
        </div>

        {/* Info text */}
        <div className="h-2.5 w-3/4 bg-muted rounded animate-pulse mx-auto" />
      </div>
    </div>
  );
}

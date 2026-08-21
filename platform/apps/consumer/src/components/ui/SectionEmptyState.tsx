import type { LucideIcon } from "lucide-react";

interface SectionEmptyStateProps {
  icon: LucideIcon;
  message: string;
  hint?: string;
}

export default function SectionEmptyState({
  icon: Icon,
  message,
  hint,
}: SectionEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      <div className="relative mb-5">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#0a0a0a]/10 to-[#404040]/10 flex items-center justify-center">
          <Icon className="h-7 w-7 text-primary/40" />
        </div>
        <div className="absolute -inset-2 rounded-2xl border border-primary/5 animate-pulse" />
      </div>
      <p className="text-sm font-medium text-muted-foreground text-center">
        {message}
      </p>
      {hint && (
        <p className="text-xs text-muted-foreground/60 mt-1 text-center">
          {hint}
        </p>
      )}
    </div>
  );
}

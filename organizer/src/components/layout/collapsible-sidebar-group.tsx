"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleSidebarGroupProps {
  label: string;
  isCollapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

export function CollapsibleSidebarGroup({
  label,
  isCollapsed,
  onToggle,
  children,
}: CollapsibleSidebarGroupProps) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="mb-2 flex w-full items-center justify-between px-2 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground transition hover:text-foreground"
      >
        <span>{label}</span>
        <ChevronRight
          className={cn(
            "size-3.5 transition-transform duration-200",
            !isCollapsed ? "rotate-90" : "",
          )}
        />
      </button>
      <div
        className={cn(
          "space-y-1.5 overflow-hidden transition-all duration-200",
          isCollapsed ? "max-h-0 opacity-0" : "max-h-[500px] opacity-100",
        )}
      >
        {children}
      </div>
    </div>
  );
}

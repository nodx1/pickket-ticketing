"use client";

import { cn } from "@/lib/utils";
import type { Command } from "./command-registry";

interface CommandItemProps {
  command: Command;
  isActive: boolean;
  onSelect: (command: Command) => void;
}

export function CommandItem({
  command,
  isActive,
  onSelect,
}: CommandItemProps) {
  const Icon = command.icon;

  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-sm transition",
        isActive
          ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
          : "text-muted-foreground hover:bg-bg-muted hover:text-foreground",
      )}
      onClick={() => onSelect(command)}
    >
      <div className="flex size-8 items-center justify-center rounded-xl bg-bg-subtle">
        <Icon className="size-4" />
      </div>
      <div className="flex-1">
        <span className="text-sm font-medium">{command.label}</span>
      </div>
      <span className="text-xs text-muted-foreground/60">{command.category}</span>
    </button>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const normalizedProps = {
    ...props,
    value: props.value === null ? "" : props.value,
  };

  return (
    <input
      type={type}
      className={cn(
        "flex h-12 w-full rounded-md border border-border bg-card px-4 py-3 text-sm text-foreground outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        "placeholder:text-muted-foreground",
        className,
      )}
      {...normalizedProps}
    />
  );
}

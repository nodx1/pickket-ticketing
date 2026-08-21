import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-lg bg-gradient-to-r from-bg-subtle via-bg-emphasis to-bg-subtle",
        className,
      )}
      {...props}
    />
  );
}

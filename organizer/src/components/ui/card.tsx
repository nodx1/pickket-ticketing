import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "card-hover rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2 p-6", className)} {...props} />;
}

/**
 * 카드 제목. 기본은 `h3` 이고, `as` 로 레벨을 올릴 수 있다.
 *
 * 🔴 2026-07-31 실측 — 결제 3단계가 전부 `CardTitle`(h3)로 시작해 **페이지에 h1 이 하나도
 *    없었다.** 화면낭독기가 문서 구조를 못 잡고, 각 단계가 독립 페이지인데 최상위 제목이 없다.
 *    스타일은 그대로 두고 **태그만** 올릴 수 있게 한다.
 */
export function CardTitle({
  className,
  as: Tag = "h3",
  ...props
}: React.ComponentProps<"h3"> & { as?: "h1" | "h2" | "h3" }) {
  return <Tag className={cn("text-xl font-semibold tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-6 pb-6", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-3 px-6 pb-6", className)} {...props} />;
}

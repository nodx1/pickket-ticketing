"use client";

import { cn } from "@/lib/utils";

interface PageTransitionProps {
  children: React.ReactNode;
  className?: string;
}

export function PageTransition({ children, className }: PageTransitionProps) {
  return <div className={cn("space-y-6", className)}>{children}</div>;
}

interface StaggerItemProps {
  children: React.ReactNode;
  index?: number;
  className?: string;
}

export function StaggerItem({
  children,
  index = 0,
  className,
}: StaggerItemProps) {
  return (
    <div
      className={cn("animate-stagger-in", className)}
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {children}
    </div>
  );
}

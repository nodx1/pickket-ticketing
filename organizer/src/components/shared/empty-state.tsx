"use client";

import type { LucideIcon } from "lucide-react";
import { CircleDashed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: LucideIcon;
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon: Icon = CircleDashed,
}: EmptyStateProps) {
  return (
    <Card className="border-dashed border-primary/20">
      <CardHeader className="items-center text-center">
        <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-primary/12 text-primary">
          <Icon aria-hidden="true" className="size-8" />
        </div>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 text-center">
        <p className="text-sm leading-7 text-muted-foreground">{description}</p>
        {actionLabel && onAction ? (
          <Button onClick={onAction}>{actionLabel}</Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

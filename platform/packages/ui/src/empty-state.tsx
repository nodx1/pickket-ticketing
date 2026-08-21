"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Inbox,
  SearchX,
  AlertTriangle,
  WifiOff,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@pickket/lib/utils";
import { Button } from "./button";

const VARIANT_DEFAULTS: Record<
  EmptyStateVariant,
  { icon: LucideIcon; title: string; description: string }
> = {
  "no-data": {
    icon: Inbox,
    title: "데이터가 없습니다",
    description: "아직 등록된 항목이 없습니다.",
  },
  "no-results": {
    icon: SearchX,
    title: "검색 결과가 없습니다",
    description: "다른 검색어로 다시 시도해 보세요.",
  },
  error: {
    icon: AlertTriangle,
    title: "오류가 발생했습니다",
    description: "잠시 후 다시 시도해 주세요.",
  },
  offline: {
    icon: WifiOff,
    title: "인터넷 연결 없음",
    description: "네트워크 연결을 확인하고 다시 시도해 주세요.",
  },
};

type EmptyStateVariant = "no-data" | "no-results" | "error" | "offline";

const emptyStateVariants = cva(
  "flex flex-col items-center justify-center gap-3 py-16 px-4 text-center",
  {
    variants: {
      variant: {
        "no-data": "",
        "no-results": "",
        error: "",
        offline: "",
      },
    },
    defaultVariants: {
      variant: "no-data",
    },
  },
);

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: "default" | "outline" | "secondary" | "ghost";
}

interface EmptyStateProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof emptyStateVariants> {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  action?: EmptyStateAction;
}

function EmptyState({
  className,
  variant = "no-data",
  icon,
  title,
  description,
  action,
  ...props
}: EmptyStateProps) {
  const v = variant ?? "no-data";
  const defaults = VARIANT_DEFAULTS[v];
  const Icon = icon ?? defaults.icon;
  const resolvedTitle = title ?? defaults.title;
  const resolvedDescription = description ?? defaults.description;

  return (
    <div
      data-slot="empty-state"
      className={cn(emptyStateVariants({ variant }), className)}
      {...props}
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-muted dark:bg-muted/50">
        <Icon className="size-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-foreground">
          {resolvedTitle}
        </h3>
        <p className="text-sm text-muted-foreground">{resolvedDescription}</p>
      </div>
      {action && (
        <Button
          variant={action.variant ?? "outline"}
          size="sm"
          onClick={action.onClick}
          className="mt-2"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

export { EmptyState, type EmptyStateProps, type EmptyStateAction };

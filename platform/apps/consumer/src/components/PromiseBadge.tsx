"use client";

import { DollarSign, Lock, Users, Heart } from "lucide-react";
import { useTranslations } from "next-intl";

type PromiseVariant = "p1" | "p2" | "p3" | "p4";

interface PromiseBadgeProps {
  variant: PromiseVariant;
}

const VARIANTS: Record<
  PromiseVariant,
  {
    icon: typeof DollarSign;
    className: string;
  }
> = {
  p1: {
    icon: DollarSign,
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  p2: {
    icon: Lock,
    className:
      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  },
  p3: {
    icon: Users,
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  },
  p4: {
    icon: Heart,
    className:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  },
};

export function PromiseBadge({ variant }: PromiseBadgeProps) {
  const t = useTranslations("promise");
  const config = VARIANTS[variant];
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium rounded-full px-2.5 py-1 whitespace-nowrap ${config.className}`}
      title={t(`${variant}.tooltip`)}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {t(`${variant}.label`)}
    </span>
  );
}

const ALL_PROMISES: PromiseVariant[] = ["p1", "p2", "p3", "p4"];

export function PromiseBadgeStrip() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ALL_PROMISES.map((v) => (
        <PromiseBadge key={v} variant={v} />
      ))}
    </div>
  );
}

"use client";

import { Shield, Scale, BadgeCheck, Ban } from "lucide-react";
import { useTranslations } from "next-intl";

type TrustBadgeVariant =
  | "safe_payment"
  | "fair_price"
  | "verified_organizer"
  | "anti_scalping";

interface TrustBadgeProps {
  variant: TrustBadgeVariant;
}

const VARIANTS: Record<
  TrustBadgeVariant,
  {
    icon: typeof Shield;
    className: string;
  }
> = {
  safe_payment: {
    icon: Shield,
    className:
      "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  },
  fair_price: {
    icon: Scale,
    className:
      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  },
  verified_organizer: {
    icon: BadgeCheck,
    className:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  },
  anti_scalping: {
    icon: Ban,
    className: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  },
};

export default function TrustBadge({ variant }: TrustBadgeProps) {
  const t = useTranslations("marketing.trustBadge");
  const config = VARIANTS[variant];
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 ${config.className}`}
    >
      <Icon className="h-3 w-3" />
      {t(variant)}
    </span>
  );
}

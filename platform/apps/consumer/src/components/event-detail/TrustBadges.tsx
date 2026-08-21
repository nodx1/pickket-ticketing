"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";

const BADGES = [
  {
    icon: "/icons/trust/fair-distribution.svg",
    color: "#00A882",
    glowColor: "rgba(0,210,160,0.15)",
    titleKey: "fairDistribution",
    subtitleKey: "fairDistributionDesc",
  },
  {
    icon: "/icons/trust/price-guarantee.svg",
    color: "hsl(var(--primary))",
    glowColor: "rgba(10,10,10,0.15)",
    titleKey: "priceGuarantee",
    subtitleKey: "priceGuaranteeDesc",
  },
  {
    icon: "/icons/trust/safe-payment.svg",
    color: "hsl(var(--primary))",
    glowColor: "rgba(10,10,10,0.15)",
    titleKey: "safePayment",
    subtitleKey: "safePaymentDesc",
  },
] as const;

export default function TrustBadges() {
  const t = useTranslations("event.trustBadges");
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {BADGES.map((badge) => (
        <div
          key={badge.titleKey}
          className="bg-card/90 backdrop-blur-sm rounded-2xl border border-border shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)] p-4 flex items-center gap-3"
        >
          <div
            className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
            style={{
              backgroundColor: badge.glowColor,
              boxShadow: `0 0 12px ${badge.glowColor}`,
            }}
          >
            <Image
              src={badge.icon}
              alt={t(badge.titleKey)}
              width={20}
              height={20}
              style={{ filter: `brightness(0) saturate(100%)` }}
              className="dark:invert"
            />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">
              {t(badge.titleKey)}
            </p>
            <p className="text-xs text-muted-foreground">{t(badge.subtitleKey)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

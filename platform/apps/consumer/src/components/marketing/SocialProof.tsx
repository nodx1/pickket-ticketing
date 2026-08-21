"use client";

import { Gift, ShoppingBag, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

export default function SocialProof() {
  const t = useTranslations("marketing.socialProof");

  const PLATFORM_STATS = [
    {
      icon: Gift,
      label: t("stat1Label"),
      desc: t("stat1Desc"),
      color: "from-primary to-brand-lighter",
    },
    {
      icon: ShoppingBag,
      label: t("stat2Label"),
      desc: t("stat2Desc"),
      color: "from-violet-500 to-violet-400",
    },
    {
      icon: ShieldCheck,
      label: t("stat3Label"),
      desc: t("stat3Desc"),
      color: "from-cyan to-teal-400",
    },
  ];

  return (
    <section className="py-8 overflow-hidden">
      <div className="max-w-7xl mx-auto section-px">
        <h3 className="text-sm font-semibold text-foreground mb-4">
          {t("heading")}
        </h3>

        <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
          {PLATFORM_STATS.map((stat) => {
            const Icon = stat.icon;
            return (
              <div
                key={stat.label}
                className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-dim shrink-0 min-w-[220px]"
              >
                <div
                  className={`w-8 h-8 rounded-full bg-gradient-to-br ${stat.color} flex items-center justify-center shrink-0`}
                >
                  <Icon className="h-4 w-4 text-white" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {stat.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{stat.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

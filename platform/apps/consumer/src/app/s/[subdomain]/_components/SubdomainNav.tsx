"use client";

import { useContext } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, MessageCircle, Ticket, Archive } from "lucide-react";
import { useTranslations } from "next-intl";
import { DetailPageContext } from "@/app/[locale]/events/[id]/detail-context";

interface SubdomainNavProps {
  basePath: string; // e.g., "/s/bts-concert"
  whiteLabel?: boolean;
}

export function SubdomainNav({
  basePath,
  whiteLabel = false,
}: SubdomainNavProps) {
  const t = useTranslations("subdomainNav");
  const pathname = usePathname();
  const { eventStatus } = useContext(DetailPageContext);
  const isCompleted = eventStatus === "completed" || eventStatus === "archived";

  const tabs = [
    {
      href: basePath,
      label: t("home"),
      icon: Home,
      match: (p: string) => p === basePath || p === `${basePath}/`,
    },
    {
      href: `${basePath}/community`,
      label: t("community"),
      icon: MessageCircle,
      match: (p: string) => p.includes("/community"),
    },
    {
      href: `${basePath}/tickets`,
      label: t("tickets"),
      icon: Ticket,
      match: (p: string) => p.includes("/tickets"),
    },
    ...(isCompleted
      ? [
          {
            href: `${basePath}/after`,
            label: t("archive"),
            icon: Archive,
            match: (p: string) => p.includes("/after"),
          },
        ]
      : []),
  ];

  return (
    <nav className="sticky top-0 z-40 backdrop-blur-xl bg-background/80 border-b border-white/5">
      <div className="max-w-[1100px] mx-auto flex">
        {tabs.map((tab) => {
          const isActive = tab.match(pathname);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors relative ${
                isActive
                  ? whiteLabel
                    ? "text-foreground"
                    : "text-primary/70"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {isActive && (
                <span
                  className={`absolute bottom-0 left-1/4 right-1/4 h-0.5 rounded-full ${
                    whiteLabel ? "bg-foreground" : "bg-primary"
                  }`}
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

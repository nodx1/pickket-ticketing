"use client";

import { useContext } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { MessageSquare, Info, Ticket, Star } from "lucide-react";
import { DetailPageContext } from "../detail-context";
import ContentWidth from "@/components/ui/ContentWidth";
import type { TabId } from "../detail-context";

interface TabDef {
  id: TabId;
  icon: typeof MessageSquare;
}

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface TabNavigationProps {
  communityCount?: number;
  reviewCount?: number;
}

export function TabNavigation({
  communityCount,
  reviewCount,
}: TabNavigationProps) {
  const t = useTranslations("event.tabNavigation");
  const { activeTab, setActiveTab } = useContext(DetailPageContext);

  const TABS: TabDef[] = [
    { id: "community", icon: MessageSquare },
    { id: "details", icon: Info },
    { id: "booking", icon: Ticket },
    { id: "reviews", icon: Star },
  ];

  const countMap: Partial<Record<TabId, number>> = {};
  if (communityCount != null) countMap.community = communityCount;
  if (reviewCount != null) countMap.reviews = reviewCount;

  return (
    <div className="sticky top-[64px] z-40 bg-background/95 backdrop-blur-xl border-b border-border">
      <ContentWidth>
        <div className="flex items-center gap-0 h-12">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const count = countMap[tab.id];
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-1.5 px-4 h-full text-sm font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? "text-primary/70"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {t(tab.id)}
                {count != null && (
                  <span
                    className={`text-2xs font-semibold px-1.5 py-0.5 rounded-full ${
                      isActive
                        ? "bg-primary/10 text-primary/70"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {formatCount(count)}
                  </span>
                )}
                {isActive && (
                  <motion.div
                    layoutId="tab-indicator"
                    className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary rounded-full"
                    transition={{
                      type: "spring",
                      bounce: 0.15,
                      duration: 0.4,
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </ContentWidth>
    </div>
  );
}

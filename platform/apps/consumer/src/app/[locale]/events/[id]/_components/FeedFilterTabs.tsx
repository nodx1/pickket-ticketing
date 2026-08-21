"use client";

import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import type { FeedFilterTab, UnifiedFeedItem } from "../community-data";

const TAB_KEYS: FeedFilterTab[] = ["all", "official", "fan", "verified"];

function getCount(tab: FeedFilterTab, items: UnifiedFeedItem[]): number {
  if (tab === "all") return items.length;
  if (tab === "official")
    return items.filter((i) => i.role === "organizer" || i.role === "artist")
      .length;
  if (tab === "fan") return items.filter((i) => i.role === "fan").length;
  if (tab === "verified")
    return items.filter((i) => i.role === "verified_attendee").length;
  return 0;
}

export function FeedFilterTabs({
  active,
  onChange,
  items,
}: {
  active: FeedFilterTab;
  onChange: (tab: FeedFilterTab) => void;
  items: UnifiedFeedItem[];
}) {
  const t = useTranslations("event.feedFilterTabs");

  return (
    <div className="flex items-center gap-1 p-1 rounded-xl bg-white/5">
      {TAB_KEYS.map((tabKey) => {
        const isActive = active === tabKey;
        const count = getCount(tabKey, items);
        return (
          <button
            key={tabKey}
            onClick={() => onChange(tabKey)}
            className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isActive
                ? "text-primary/70"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {isActive && (
              <motion.div
                layoutId="feed-filter-indicator"
                className="absolute inset-0 rounded-lg bg-background shadow-sm"
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}
            <span className="relative z-10">{t(tabKey)}</span>
            <span
              className={`relative z-10 text-xs-plus ${
                isActive ? "text-primary/70" : "text-muted-foreground/60"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

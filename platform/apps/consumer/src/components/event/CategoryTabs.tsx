"use client";

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Music,
  Drama,
  Trophy,
  Music2,
  Palette,
  PartyPopper,
  Landmark,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { CATEGORIES, type CategorySlug } from "@pickket/lib";
import { useTranslations } from "next-intl";

/* ── Icon map ──────────────────────────────────────────────────────── */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Music,
  Drama,
  Trophy,
  Music2,
  Palette,
  PartyPopper,
};

/* ── Category gradient backgrounds for active state ────────────────── */
const CATEGORY_BG: Record<string, string> = {
  concert:
    "bg-gradient-to-r from-red-500/10 to-pink-500/10 dark:from-red-500/20 dark:to-pink-500/20 border-red-400/40 text-red-600 dark:text-red-400",
  musical:
    "bg-gradient-to-r from-teal-500/10 to-emerald-500/10 dark:from-teal-500/20 dark:to-emerald-500/20 border-teal-400/40 text-teal-600 dark:text-teal-400",
  sports:
    "bg-gradient-to-r from-blue-500/10 to-sky-500/10 dark:from-blue-500/20 dark:to-sky-500/20 border-blue-400/40 text-blue-600 dark:text-blue-400",
  classical:
    "bg-gradient-to-r from-green-500/10 to-emerald-500/10 dark:from-green-500/20 dark:to-emerald-500/20 border-green-400/40 text-green-600 dark:text-green-400",
  exhibition:
    "bg-gradient-to-r from-amber-500/10 to-yellow-500/10 dark:from-amber-500/20 dark:to-yellow-500/20 border-amber-400/40 text-amber-600 dark:text-amber-400",
  festival:
    "bg-gradient-to-r from-purple-500/10 to-fuchsia-500/10 dark:from-purple-500/20 dark:to-fuchsia-500/20 border-fuchsia-400/40 text-purple-600 dark:text-purple-400",
};

/* ── Icon accent color (for the icon container) ────────────────────── */
const CATEGORY_ICON_BG: Record<string, string> = {
  concert: "bg-red-500 text-white",
  musical: "bg-teal-500 text-white",
  sports: "bg-blue-500 text-white",
  classical: "bg-green-500 text-white",
  exhibition: "bg-amber-500 text-white",
  festival: "bg-purple-500 text-white",
};

/* Pages where category tabs should be hidden */
const HIDDEN_PATHS = [
  "/auth",
  "/onboarding",
  "/orders",
  "/tickets/",
  "/resale/",
  "/sell",
  "/staff/",
];

/* ── Tab items from shared constants ───────────────────────────────── */
const TAB_ITEMS = CATEGORIES.map((c) => ({
  slug: c.slug as CategorySlug,
  label: c.label,
  icon: c.icon,
}));

export default function CategoryTabs() {
  const t = useTranslations("common");
  const pathname = usePathname();
  const scrollRef = useRef<HTMLDivElement>(null);

  /* Hide tabs on focus-flow pages */
  const isHidden = HIDDEN_PATHS.some((p) => pathname.startsWith(p));
  /* Also hide on individual event detail pages */
  const isEventDetail =
    pathname.startsWith("/events/") &&
    !pathname.startsWith("/events/create") &&
    !pathname.endsWith("/edit") &&
    !pathname.endsWith("/report");
  if (isHidden || isEventDetail) return null;

  const scroll = (direction: "left" | "right") => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({
      left: direction === "left" ? -200 : 200,
      behavior: "smooth",
    });
  };

  return (
    <div className="sticky top-[64px] z-30 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="max-w-7xl mx-auto px-4 md:px-10 lg:px-16 relative">
        {/* Left scroll arrow */}
        <button
          type="button"
          onClick={() => scroll("left")}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-background/90 border border-border shadow-sm items-center justify-center hover:bg-muted transition-colors hidden md:flex"
          aria-label={t("scroll_left")}
        >
          <ChevronLeft className="h-4 w-4 text-muted-foreground" />
        </button>

        {/* Scrollable tabs */}
        <div
          ref={scrollRef}
          className="flex items-center gap-2 py-2.5 overflow-x-auto scrollbar-hide scroll-smooth md:px-6"
        >
          {TAB_ITEMS.map((item) => {
            const Icon = ICON_MAP[item.icon];
            const isActive = pathname.startsWith(`/category/${item.slug}`);
            const activeBg = CATEGORY_BG[item.slug] || "";
            const activeIconBg =
              CATEGORY_ICON_BG[item.slug] || "bg-primary text-white";

            return (
              <Link
                key={item.slug}
                href={`/category/${item.slug}`}
                className={`flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium whitespace-nowrap transition-all duration-200 shrink-0 ${
                  isActive
                    ? `${activeBg} shadow-sm`
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <span
                  className={`flex items-center justify-center h-6 w-6 rounded-full transition-all ${
                    isActive ? activeIconBg : "bg-muted text-muted-foreground"
                  }`}
                >
                  {Icon && <Icon className="h-3.5 w-3.5" />}
                </span>
                {item.label}
              </Link>
            );
          })}

          {/* Divider */}
          <div className="w-px h-6 bg-border shrink-0 mx-1" />

          {/* Public reservation link */}
          <Link
            href="/government"
            className={`flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium whitespace-nowrap transition-all duration-200 shrink-0 ${
              pathname.startsWith("/government")
                ? "bg-primary/10 dark:bg-primary/20 border-primary/40 text-primary shadow-sm"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            <span
              className={`flex items-center justify-center h-6 w-6 rounded-full transition-all ${
                pathname.startsWith("/government")
                  ? "bg-primary text-white"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Landmark className="h-3.5 w-3.5" />
            </span>
            공공예약
          </Link>
        </div>

        {/* Right scroll arrow */}
        <button
          type="button"
          onClick={() => scroll("right")}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full bg-background/90 border border-border shadow-sm items-center justify-center hover:bg-muted transition-colors hidden md:flex"
          aria-label={t("scroll_right")}
        >
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}

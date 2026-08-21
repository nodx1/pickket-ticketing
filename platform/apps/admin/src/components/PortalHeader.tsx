"use client";

import { ArrowLeft, ChevronRight, Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";

interface PortalHeaderProps {
  consumerUrl: string;
  onMenuToggle: () => void;
}

const PAGE_TITLE_KEYS: Record<string, string> = {
  "/": "pages.dashboard",
  "/users": "pages.users",
  "/onboarding": "pages.onboarding",
  "/events": "pages.events",
  "/communities": "pages.communities",
  "/audit": "pages.audit",
  "/auth": "pages.auth",
};

function getCurrentPageTitleKey(pathname: string): string {
  const sortedKeys = Object.keys(PAGE_TITLE_KEYS).sort(
    (a, b) => b.length - a.length,
  );
  const matchedKey = sortedKeys.find((key) => {
    if (key === "/") return pathname === "/";
    return pathname === key || pathname.startsWith(`${key}/`);
  });
  return matchedKey ? PAGE_TITLE_KEYS[matchedKey] : "pages.dashboard";
}

export default function PortalHeader({
  consumerUrl,
  onMenuToggle,
}: PortalHeaderProps) {
  const t = useTranslations("common.portalHeader");
  const pathname = usePathname();
  const title = t(getCurrentPageTitleKey(pathname));

  return (
    <header className="fixed top-0 left-0 right-0 md:left-[220px] h-14 bg-background border-b border-border flex items-center px-4 md:px-6 z-30">
      <button
        type="button"
        onClick={onMenuToggle}
        className="md:hidden mr-3 p-1.5 rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        aria-label={t("menuOpen")}
      >
        <Menu className="h-5 w-5" />
      </button>

      <nav
        aria-label="breadcrumb"
        className="flex items-center gap-1.5 text-sm min-w-0"
      >
        <span className="text-muted-foreground">Pickket Admin</span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
        <span className="font-medium truncate">{title}</span>
      </nav>

      <div className="flex-1" />

      <a
        href={consumerUrl}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">
          {(() => {
            try {
              return new URL(consumerUrl).hostname;
            } catch {
              return "pickket.kr";
            }
          })()}
        </span>
      </a>
    </header>
  );
}

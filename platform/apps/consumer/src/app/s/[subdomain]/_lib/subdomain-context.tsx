"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, useCallback, type ReactNode } from "react";
import {
  DetailPageContext,
  type TabId,
} from "@/app/[locale]/events/[id]/detail-context";

interface SubdomainProviderProps {
  children: ReactNode;
  event: {
    id: string;
    bid_count?: number;
    view_count?: number;
    total_seats?: number;
    status?: string;
    category?: string;
  };
}

export function SubdomainProvider({ children, event }: SubdomainProviderProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Derive subdomain base path: /s/{slug}
  const basePath = useMemo(() => {
    const match = pathname.match(/^\/s\/[^/]+/);
    return match ? match[0] : "/s/unknown";
  }, [pathname]);

  const activeTab: TabId = useMemo(() => {
    if (pathname.endsWith("/community")) return "community";
    if (pathname.endsWith("/tickets")) return "booking";
    return "community"; // landing page defaults to community for context compat
  }, [pathname]);

  const setActiveTab = useCallback(
    (tab: TabId) => {
      switch (tab) {
        case "booking":
          router.push(`${basePath}/tickets`);
          break;
        case "community":
          router.push(`${basePath}/community`);
          break;
        case "details":
          router.push(basePath);
          break;
        case "reviews":
          router.push(`${basePath}/community`);
          break;
        default:
          router.push(`${basePath}/community`);
      }
    },
    [router, basePath],
  );

  const value = useMemo(
    () => ({
      activeTab,
      setActiveTab,
      bidCount: event.bid_count ?? 0,
      viewCount: event.view_count ?? 0,
      totalSeats: event.total_seats ?? 0,
      eventStatus: event.status ?? "",
      category: event.category ?? "",
    }),
    [activeTab, setActiveTab, event],
  );

  return (
    <DetailPageContext.Provider value={value}>
      {children}
    </DetailPageContext.Provider>
  );
}

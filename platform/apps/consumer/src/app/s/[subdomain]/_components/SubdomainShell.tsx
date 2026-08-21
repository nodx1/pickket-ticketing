"use client";

import { useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SubdomainProvider } from "../_lib/subdomain-context";
import { SubdomainNav } from "./SubdomainNav";

interface EventData {
  id: string;
  title: string;
  bid_count?: number;
  view_count?: number;
  total_seats?: number;
  status?: string;
  category?: string;
  page_theme?: { logoUrl?: string } | null;
}

interface SubdomainShellProps {
  event: EventData;
  children: ReactNode;
}

export function SubdomainShell({ event, children }: SubdomainShellProps) {
  const pathname = usePathname();
  const basePath = useMemo(() => {
    const match = pathname.match(/^\/s\/[^/]+/);
    return match ? match[0] : "/s/unknown";
  }, [pathname]);

  return (
    <SubdomainProvider event={event}>
      <SubdomainNav basePath={basePath} />
      <main className="min-h-screen">{children}</main>
    </SubdomainProvider>
  );
}

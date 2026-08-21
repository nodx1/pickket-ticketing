"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calendar, CreditCard, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "대시보드", icon: LayoutDashboard },
  { href: "/events", label: "이벤트", icon: Calendar },
  { href: "/account/settlements", label: "정산", icon: CreditCard },
];

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card lg:hidden">
      <div className="flex items-center justify-around px-2 py-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              {...(active ? { "aria-current": "page" as const } : {})}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[10px] transition",
                active ? "text-primary" : "text-content-muted",
              )}
            >
              <Icon className="size-5" />
              {active && <span className="font-medium">{item.label}</span>}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

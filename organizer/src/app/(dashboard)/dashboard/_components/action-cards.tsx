"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Clock, PackageX } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";

interface ActionItem {
  type: string;
  count: number;
  label: string;
}

const iconMap: Record<string, LucideIcon> = {
  recent_refunds: AlertTriangle,
  expiring_orders: Clock,
  low_stock: PackageX,
};

const colorMap: Record<string, { text: string; bg: string }> = {
  recent_refunds: { text: "text-warning", bg: "bg-warning/15" },
  expiring_orders: { text: "text-gold", bg: "bg-gold/15" },
  low_stock: { text: "text-accent", bg: "bg-accent/15" },
};

export function ActionCards({ actions }: { actions: ActionItem[] }) {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        처리 필요
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {actions.map((action) => {
          const Icon = iconMap[action.type] ?? AlertTriangle;
          const colors = colorMap[action.type] ?? {
            text: "text-muted-foreground",
            bg: "bg-muted",
          };

          return (
            <Link key={action.type} href="/events">
              <Card className="flex items-center gap-4 p-4 transition hover:border-border-emphasis">
                <div className={`flex size-10 items-center justify-center rounded-lg ${colors.bg}`}>
                  <Icon className={`size-5 ${colors.text}`} />
                </div>
                <div>
                  <p className="text-2xl font-black text-foreground">{action.count}</p>
                  <p className="text-sm text-muted-foreground">{action.label}</p>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

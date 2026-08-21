"use client";

import { Menu } from "lucide-react";
import { useState } from "react";
import { DashboardSidebar } from "@/components/layout/dashboard-sidebar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

export function MobileSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          data-tutorial="mobile-menu-button"
          aria-label="메뉴 열기"
          className="flex size-10 items-center justify-center rounded-lg border border-border bg-bg-muted text-foreground transition hover:bg-bg-emphasis lg:hidden"
        >
          <Menu className="size-5" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[250px] border-r border-sidebar-border bg-sidebar p-0">
        <DashboardSidebar />
      </SheetContent>
    </Sheet>
  );
}

"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell, BookImage, Building2, Calendar, ChevronsLeft, ChevronsRight,
  CreditCard, FileCheck, GraduationCap, LayoutDashboard, LogOut, QrCode, RotateCcw, Settings, Shield, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSidebarStore, useSidebarHydration } from "@/lib/stores/sidebarStore";
import { useTutorialStore } from "@/lib/stores/tutorialStore";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

const mainItems = [
  { href: "/dashboard", label: "개요", icon: LayoutDashboard },
  { href: "/events", label: "이벤트", icon: Calendar, tutorialId: "sidebar-events" },
  { href: "/account/settlements", label: "정산", icon: CreditCard },
];

const manageItems = [
  { href: "/organizers", label: "주최자", icon: Building2 },
  { href: "/account/members", label: "팀 멤버", icon: Users },
  { href: "/checkin", label: "현장 체크인", icon: QrCode },
  { href: "/notifications", label: "알림", icon: Bell },
];

const settingItems = [
  { href: "/account", label: "계정설정", icon: Settings },
  { href: "/account/security", label: "보안 (MFA)", icon: Shield },
  // 컴플라이언스/감사 로그 — 이벤트 토글에서 계정 설정 레벨로 이동 (Phase2 슬림화)
  { href: "/account/compliance", label: "컴플라이언스", icon: FileCheck },
  { href: "/design-guide", label: "디자인 가이드", icon: BookImage },
];

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
  tutorialId,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  collapsed: boolean;
  tutorialId?: string;
}) {
  const link = (
    <Link
      href={href}
      {...(tutorialId ? { "data-tutorial": tutorialId } : {})}
      {...(active ? { "aria-current": "page" as const } : {})}
      className={cn(
        "flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition",
        collapsed && "justify-center px-0",
        active
          ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
          : "text-content-subtle hover:bg-bg-emphasis hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span>{label}</span>}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

function NavSection({
  title,
  items,
  pathname,
  collapsed,
}: {
  title: string;
  items: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }>; tutorialId?: string }>;
  pathname: string;
  collapsed: boolean;
}) {
  return (
    <div className="space-y-1">
      {!collapsed && (
        <p className="mb-2 px-4 text-[11px] font-semibold uppercase tracking-widest text-content-subtle">
          {title}
        </p>
      )}
      {items.map((item) => {
        const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
        return (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={active}
            collapsed={collapsed}
            tutorialId={item.tutorialId}
          />
        );
      })}
    </div>
  );
}

export function DashboardSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { isCollapsed, toggle } = useSidebarStore();
  useSidebarHydration();
  const { resetAll, startTour, activeTourId, completedTours } = useTutorialStore();
  // hydration safety — localStorage 기반 완료 이력은 클라이언트 마운트 후에만 표시.
  // setState-in-effect 대신 useSyncExternalStore 로 SSR=false / 클라=true 를 순수하게 도출.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const hasCompletedAny = mounted && completedTours.length > 0;

  async function handleLogout() {
    window.dispatchEvent(new Event("pickket:logout"));
    try {
      await fetchWithRefresh("/api/auth/logout", { method: "POST" });
    } catch (err: unknown) {
      console.warn("로그아웃 요청 실패:", err instanceof Error ? err.message : err);
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <TooltipProvider>
      <aside
        className={cn(
          "flex min-h-screen flex-col border-r border-sidebar-border bg-sidebar py-6 transition-all duration-300 lg:h-full lg:min-h-0",
          isCollapsed ? "w-[68px] px-2" : "w-[240px] px-5",
        )}
      >
        <div className={cn("flex items-center", isCollapsed ? "justify-center" : "justify-between")}>
          {!isCollapsed && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">
                pickket.go
              </p>
              <h2 className="mt-1 text-lg font-black tracking-[-0.05em] text-foreground">
                운영 콘솔
              </h2>
            </div>
          )}
          <button
            type="button"
            onClick={toggle}
            className="flex size-8 items-center justify-center rounded-md text-content-muted transition hover:bg-bg-emphasis hover:text-foreground"
            aria-label={isCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
          >
            {isCollapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          </button>
        </div>

        <nav className="mt-8 flex-1 space-y-6">
          <NavSection title="메인" items={mainItems} pathname={pathname} collapsed={isCollapsed} />
          <NavSection title="관리" items={manageItems} pathname={pathname} collapsed={isCollapsed} />
          <NavSection title="설정" items={settingItems} pathname={pathname} collapsed={isCollapsed} />
        </nav>

        <div className="space-y-2">
          {!isCollapsed ? (
            <>
              <button
                type="button"
                onClick={() => { if (!activeTourId) startTour("welcome"); }}
                disabled={!!activeTourId}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium text-content-subtle transition hover:bg-bg-emphasis hover:text-foreground disabled:opacity-40"
              >
                <GraduationCap className="size-4" />
                가이드 투어
              </button>
              {hasCompletedAny && (
                <button
                  type="button"
                  onClick={() => { resetAll(); startTour("welcome"); }}
                  disabled={!!activeTourId}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-xs text-content-muted transition hover:bg-bg-emphasis hover:text-content-subtle disabled:opacity-40"
                >
                  <RotateCcw className="size-3.5" />
                  투어 초기화
                </button>
              )}
              <Button variant="outline" className="w-full justify-start border-border bg-bg-muted text-foreground hover:bg-bg-emphasis" onClick={handleLogout}>
                <LogOut className="size-4" />
                로그아웃
              </Button>
            </>
          ) : (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex w-full justify-center rounded-lg py-3 text-content-subtle transition hover:bg-bg-emphasis hover:text-foreground"
                >
                  <LogOut className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>로그아웃</TooltipContent>
            </Tooltip>
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
}

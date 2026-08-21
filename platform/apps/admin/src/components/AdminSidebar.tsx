"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Activity,
  Bell,
  Calendar,
  ClipboardList,
  Crown,
  DollarSign,
  FileBarChart,
  FileText,
  Filter,
  FlaskConical,
  Handshake,
  Heart,
  Headset,
  Landmark,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  MessageSquareWarning,
  Repeat2,
  RotateCcw,
  Settings,
  Shield,
  ShoppingCart,
  Timer,
  ToggleLeft,
  UserCheck,
  Users,
} from "lucide-react";

import { cn, maskEmail } from "@pickket/lib";
import { useAuthStore } from "@pickket/store";
import { useUserRole, ROLE_SCOPES } from "../hooks/usePermission";
import LogoutDialog from "./LogoutDialog";

type SidebarMode = "desktop" | "mobile";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  requiredScope?: string;
}

interface NavGroup {
  key: string;
  title: string;
  items: NavItem[];
}

interface AdminSidebarProps {
  mode?: SidebarMode;
  onNavigate?: () => void;
  onLogout?: () => void;
}

const NAV_GROUPS: NavGroup[] = [
  {
    key: "core",
    title: "Core",
    items: [
      {
        label: "대시보드",
        href: "/",
        icon: <LayoutDashboard className="h-4 w-4" />,
      },
      {
        label: "사용자",
        href: "/users",
        icon: <Users className="h-4 w-4" />,
        requiredScope: "users.manage",
      },
      {
        label: "이벤트 심사",
        href: "/events/pending",
        icon: <Shield className="h-4 w-4" />,
        requiredScope: "events.manage",
      },
      {
        label: "이벤트",
        href: "/events",
        icon: <Calendar className="h-4 w-4" />,
        requiredScope: "events.manage",
      },
    ],
  },
  {
    key: "partners",
    title: "Partners",
    items: [
      {
        label: "주최자 관리",
        href: "/onboarding",
        icon: <UserCheck className="h-4 w-4" />,
        requiredScope: "organizers.manage",
      },
      {
        label: "매출/정산",
        href: "/finance",
        icon: <DollarSign className="h-4 w-4" />,
        requiredScope: "finance.view",
      },
      {
        label: "정산 관리",
        href: "/settlements",
        icon: <Landmark className="h-4 w-4" />,
        requiredScope: "settlements.approve",
      },
      {
        label: "파트너",
        href: "/partners",
        icon: <Handshake className="h-4 w-4" />,
        requiredScope: "organizers.manage",
      },
      {
        label: "전환 퍼널",
        href: "/funnel",
        icon: <Filter className="h-4 w-4" />,
        requiredScope: "finance.view",
      },
      {
        label: "커스텀 리포트",
        href: "/reports",
        icon: <FileBarChart className="h-4 w-4" />,
        requiredScope: "finance.view",
      },
    ],
  },
  {
    key: "operations",
    title: "Operations",
    items: [
      {
        label: "주문 관리",
        href: "/orders",
        icon: <ShoppingCart className="h-4 w-4" />,
        requiredScope: "orders.manage",
      },
      {
        label: "환불 관리",
        href: "/refunds",
        icon: <RotateCcw className="h-4 w-4" />,
        requiredScope: "refunds.approve",
      },
      {
        label: "리세일 마켓",
        href: "/resale",
        icon: <Repeat2 className="h-4 w-4" />,
        requiredScope: "events.manage",
      },
      {
        label: "대기열",
        href: "/queue",
        icon: <Timer className="h-4 w-4" />,
        requiredScope: "events.manage",
      },
      {
        label: "알림 센터",
        href: "/notifications",
        icon: <Bell className="h-4 w-4" />,
        requiredScope: "notifications.send",
      },
      {
        label: "커뮤니티",
        href: "/communities",
        icon: <MessageSquare className="h-4 w-4" />,
        requiredScope: "communities.manage",
      },
      {
        label: "댓글 관리",
        href: "/moderation",
        icon: <MessageSquareWarning className="h-4 w-4" />,
        requiredScope: "communities.manage",
      },
      {
        label: "CS 티켓",
        href: "/cs",
        icon: <Headset className="h-4 w-4" />,
        requiredScope: "cs.manage",
      },
      {
        label: "템플릿 변경",
        href: "/template-requests",
        icon: <FileText className="h-4 w-4" />,
        requiredScope: "communities.manage",
      },
      {
        label: "팬 요청",
        href: "/fan-requests",
        icon: <Heart className="h-4 w-4" />,
        requiredScope: "events.manage",
      },
    ],
  },
  {
    key: "system",
    title: "System",
    items: [
      {
        label: "운영 보드",
        href: "/ops",
        icon: <ClipboardList className="h-4 w-4" />,
        requiredScope: "*",
      },
      {
        label: "권한 관리",
        href: "/roles",
        icon: <Crown className="h-4 w-4" />,
        requiredScope: "*",
      },
      {
        label: "도메인 설정",
        href: "/settings",
        icon: <Settings className="h-4 w-4" />,
        requiredScope: "*",
      },
      {
        label: "감사 로그",
        href: "/audit",
        icon: <Shield className="h-4 w-4" />,
        requiredScope: "audit.view",
      },
      {
        label: "Feature Flags",
        href: "/feature-flags",
        icon: <ToggleLeft className="h-4 w-4" />,
        requiredScope: "*",
      },
      {
        label: "A/B 실험",
        href: "/experiments",
        icon: <FlaskConical className="h-4 w-4" />,
        requiredScope: "*",
      },
      {
        label: "시스템",
        href: "/system",
        icon: <Activity className="h-4 w-4" />,
        requiredScope: "*",
      },
    ],
  },
];

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AdminSidebar({
  mode = "desktop",
  onNavigate,
  onLogout,
}: AdminSidebarProps) {
  const pathname = usePathname();
  const { user } = useAuthStore();
  const role = useUserRole();
  const tNav = useTranslations("nav.groups");

  const hasScope = (scope: string): boolean => {
    const allowed = ROLE_SCOPES[role];
    if (!allowed) return false;
    return allowed.has("*") || allowed.has(scope);
  };

  return (
    <aside
      className={cn(
        "bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col",
        mode === "desktop" &&
          "fixed top-0 left-0 bottom-0 w-[220px] z-40 hidden md:flex",
        mode === "mobile" && "h-full w-full",
      )}
    >
      <div className="h-14 px-4 flex items-center gap-2 border-b border-sidebar-border">
        <div className="h-6 w-6 rounded bg-white flex items-center justify-center">
          <span className="text-black text-xs font-bold">P</span>
        </div>
        <span className="text-sm-minus font-semibold text-foreground">
          Pickket Admin
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {NAV_GROUPS.map((group, groupIndex) => {
          const filteredItems = group.items.filter(
            (item) => !item.requiredScope || hasScope(item.requiredScope),
          );
          if (filteredItems.length === 0) return null;

          return (
            <div key={group.key}>
              <div className="px-4 pt-3 pb-1">
                <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {tNav(group.key)}
                </span>
              </div>
              {filteredItems.map((item) => {
                const active = isActivePath(pathname, item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-1.5 mx-2 rounded-md text-sm-minus transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                      active
                        ? "text-foreground bg-sidebar-accent shadow-[inset_0_0_0_1px_var(--sidebar-border)]"
                        : "text-sidebar-foreground hover:text-foreground hover:bg-sidebar-accent/50",
                    )}
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}

              {groupIndex < NAV_GROUPS.length - 1 && (
                <div className="h-px bg-sidebar-border mx-4 my-2" />
              )}
            </div>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-sidebar-border px-4 py-3 flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center text-white text-xs-plus font-medium">
          {user?.name?.charAt(0) || "A"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm-minus text-foreground truncate">
            {user?.name || "Admin"}
          </p>
          <p className="text-xs-plus text-muted-foreground truncate">
            {user?.email ? maskEmail(user.email) : ""}
          </p>
        </div>
        {onLogout && (
          <LogoutDialog onConfirm={onLogout}>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring rounded-sm"
              aria-label="로그아웃"
              title="로그아웃"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </LogoutDialog>
        )}
      </div>
    </aside>
  );
}

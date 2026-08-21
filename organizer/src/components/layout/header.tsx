"use client";

import { useEffect } from "react";
import { ChevronDown, LogOut, Search, Settings, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { NotificationBell } from "@/components/layout/notification-bell";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCommandPalette } from "@/lib/stores/commandPaletteStore";
import { useAuthStore } from "@/lib/stores/authStore";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { fetchWithRefresh } from "@/lib/fetchWithAuth";

function avatarInitials(name: string | undefined): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // 한글 이름은 마지막 두 글자, 영문은 단어 앞글자 2개
  const isKorean = /[\uac00-\ud7a3]/.test(trimmed);
  if (isKorean) return trimmed.slice(-2);
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Header() {
  const router = useRouter();
  const openPalette = useCommandPalette((state) => state.open);
  const user = useAuthStore((state) => state.user);
  const fetchMe = useAuthStore((state) => state.fetchMe);

  useEffect(() => {
    if (!user) {
      void fetchMe();
    }
  }, [user, fetchMe]);

  const displayName = user?.name?.trim() || (user?.role ? USER_ROLE_LABELS[user.role] : "내 계정");
  const initials = avatarInitials(user?.name);

  async function handleLogout() {
    try {
      await fetchWithRefresh("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (err: unknown) {
      console.warn("로그아웃 요청 실패:", err instanceof Error ? err.message : err);
    }
    router.push("/login");
  }

  return (
    <header className="flex h-16 items-center justify-between rounded-lg border border-border bg-card px-5 shadow-sm">
      <div>
        <p className="hidden text-xs font-semibold uppercase tracking-[0.2em] text-primary sm:block">
          dashboard
        </p>
        <div className="mt-1">
          <Breadcrumb />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={openPalette}
          data-tutorial="header-search"
          className="flex items-center gap-2 rounded-full border border-border bg-bg-muted px-3 py-2 text-sm text-content-subtle transition hover:bg-bg-emphasis hover:text-foreground"
        >
          <Search className="size-4" />
          <span className="hidden sm:inline">검색</span>
          <kbd className="hidden rounded-md border border-border bg-bg-subtle px-1.5 py-0.5 text-[10px] sm:inline-block">
            ⌘K
          </kbd>
        </button>
        <div data-tutorial="header-notifications">
          <NotificationBell />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-3 rounded-full border border-border bg-muted px-3 py-2 text-sm text-foreground">
            <Avatar className="size-8">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="hidden sm:inline">{displayName}</span>
            <ChevronDown className="size-4 text-content-muted" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href="/account">
                <User className="mr-2 size-4" />
                프로필
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/account">
                <Settings className="mr-2 size-4" />
                계정설정
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void handleLogout()}>
              <LogOut className="mr-2 size-4" />
              로그아웃
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

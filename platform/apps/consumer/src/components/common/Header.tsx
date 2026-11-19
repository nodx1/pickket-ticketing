"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { Bell, UserRound } from "lucide-react";
import { useAuthStore } from "@pickket/store";
import { getUnreadNotificationCount } from "@pickket/lib/api";
import { DesktopNavLinks } from "@/components/nav/NavLinks";
import SearchBar from "@/components/nav/SearchBar";
import MobileNav from "@/components/nav/MobileNav";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

function UserActionsSkeleton() {
  return (
    <>
      <div className="hidden md:flex w-9 h-9 rounded-full bg-muted animate-pulse" />
      <div className="md:hidden w-9 h-9 rounded-full bg-muted animate-pulse" />
    </>
  );
}

interface HeaderProps {
  variant?: "default" | "transparent";
}

export default function Header({ variant = "default" }: HeaderProps) {
  const t = useTranslations("common.header");
  const { user, logout } = useAuthStore();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (variant !== "transparent") return;
    const onScroll = () => setScrolled(window.scrollY > 50);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [variant]);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!user) return;
    const load = () =>
      getUnreadNotificationCount()
        .then((count) => setUnreadCount(count))
        .catch(() => {});
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [user]);

  const handleLogout = () => {
    logout();
    // Clear all cached PII (orders, tickets, etc.) so a subsequent user on a
    // shared device cannot see previous user's data during the 30-min gcTime.
    queryClient.clear();
    setMobileMenuOpen(false);
    router.push("/");
  };

  // transparent 모드에서 스크롤 전이면 히어로 위 흰색 텍스트
  const isOverlay = variant === "transparent" && !scrolled;

  return (
    <header
      className={`fixed top-0 w-full z-50 transition-all duration-300 ${
        variant === "transparent" && !scrolled
          ? "bg-transparent"
          : "bg-primary text-white shadow-sm"
      }`}
    >
      <nav className="flex items-center justify-between py-3 max-w-7xl mx-auto px-4 sm:px-8">
        {/* Left: Logo + Nav links */}
        <div className="flex items-center gap-10">
          <Link
            href="/"
            aria-label="Pickket Home"
            className="flex items-center gap-2 shrink-0"
          >
            <span className="text-xl font-black tracking-tighter uppercase text-white">
              pickket
            </span>
            <span className="hidden sm:block text-2xs font-medium tracking-wide text-white/50">
              {t("tagline")}
            </span>
          </Link>

          <DesktopNavLinks overlay={isOverlay} />
        </div>

        {/* Right: Search + Actions */}
        <div className="flex items-center gap-3">
          <SearchBar overlay={isOverlay} />

          {!hydrated ? (
            <UserActionsSkeleton />
          ) : (
            <>
              {/* 테마 토글 숨김 — 라이트모드 고정 */}

              <Link
                href="/notifications"
                className="relative hidden md:flex p-2 rounded-full transition-all hover:bg-white/10"
                aria-label={t("notifications")}
              >
                <Bell className="h-5 w-5 text-white/80" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 rounded-full bg-red-600 text-2xs text-white flex items-center justify-center font-bold px-1">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </Link>

              <Link
                href={user ? "/mypage" : "/auth"}
                aria-label={user ? t("mypage") : t("login")}
                className="hidden md:flex w-9 h-9 rounded-full border-2 items-center justify-center transition-all border-white/30 bg-white/10 hover:border-white/60"
              >
                <UserRound className="h-4 w-4 text-white/80" />
              </Link>

              {/* 홈 화면에 추가(PWA) — 설치 가능한 브라우저에서만 보임 */}
              <InstallAppButton variant="header" />

              <MobileNav
                open={mobileMenuOpen}
                onOpenChange={setMobileMenuOpen}
                onLogout={handleLogout}
                unreadCount={unreadCount}
              />
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

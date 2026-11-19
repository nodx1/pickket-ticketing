"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ticket, LogOut, User, Bell, Menu } from "lucide-react";
import { Button } from "@pickket/ui";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { CATEGORIES } from "@pickket/lib";
import {
  NAV_LINKS,
  PARTNER_LINKS,
  POLICY_LINKS,
  isLinkActive,
} from "./NavLinks";
import LocaleSwitcher from "@/components/nav/LocaleSwitcher";
import ThemeToggle from "@/components/nav/ThemeToggle";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";

interface MobileNavProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogout: () => void;
  unreadCount?: number;
}

export default function MobileNav({
  open,
  onOpenChange,
  onLogout,
  unreadCount = 0,
}: MobileNavProps) {
  const { user } = useAuthStore();
  const pathname = usePathname();
  const t = useTranslations("nav");
  const tCat = useTranslations("categories");

  const closeMenu = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="메뉴 열기"
          className="h-11 w-11 md:hidden"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[300px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-primary">
            <Ticket className="h-5 w-5" />
            Pick<span className="text-cyan">&middot;</span>ket
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-1">
          {/* Nav links */}
          {NAV_LINKS.map((link) => (
            <Link
              key={link.tKey}
              href={link.href}
              onClick={closeMenu}
              className={`flex items-center gap-2 px-3 py-3 text-sm rounded-lg transition-colors ${
                isLinkActive(pathname, link.href)
                  ? "bg-primary/10 text-primary font-medium"
                  : "hover:bg-muted"
              }`}
            >
              {t(link.tKey)}
            </Link>
          ))}

          {/* Partner links */}
          <div className="pt-3 pb-1 px-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("forOrganizers")}
            </p>
          </div>
          {PARTNER_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.tKey}
                href={link.href}
                onClick={closeMenu}
                className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                  isLinkActive(pathname, link.href)
                    ? "bg-primary/10 text-primary font-medium"
                    : "hover:bg-muted"
                }`}
              >
                <Icon className="h-4 w-4" />
                {t(link.tKey)}
              </Link>
            );
          })}

          {/* Categories */}
          <div className="pt-3 pb-1 px-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("categories")}
            </p>
          </div>
          {CATEGORIES.map((cat) => (
            <Link
              key={cat.slug}
              href={`/category/${cat.slug}`}
              onClick={closeMenu}
              className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                pathname.startsWith(`/category/${cat.slug}`)
                  ? "bg-primary/10 text-primary font-medium"
                  : "hover:bg-muted"
              }`}
            >
              {tCat(cat.slug)}
            </Link>
          ))}

          {/* Policy links */}
          <div className="pt-3 pb-1 px-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("policy")}
            </p>
          </div>
          {POLICY_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={closeMenu}
                className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground rounded-lg hover:bg-muted transition-colors"
              >
                <Icon className="h-4 w-4" />
                {t(link.tKey)}
              </Link>
            );
          })}

          {/* Theme + Language */}
          <div className="border-t border-border mt-3 pt-3 px-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">테마</span>
              <ThemeToggle />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Language</span>
              <LocaleSwitcher />
            </div>
          </div>

          {/* User actions */}
          <div className="border-t border-border mt-3 pt-3 space-y-1">
            <InstallAppButton variant="menu" onDone={closeMenu} />
            {user ? (
              <>
                <Link
                  href="/notifications"
                  onClick={closeMenu}
                  className="flex items-center gap-2 px-3 py-3 text-sm rounded-lg hover:bg-muted transition-colors"
                >
                  <span className="relative">
                    <Bell className="h-4 w-4" />
                    {unreadCount > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] rounded-full bg-red-600 text-xs text-white flex items-center justify-center font-bold px-1">
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </span>
                    )}
                  </span>
                  {t("notifications")}
                </Link>
                <Link
                  href="/mypage"
                  onClick={closeMenu}
                  className="flex items-center gap-2 px-3 py-3 text-sm rounded-lg hover:bg-muted transition-colors"
                >
                  <User className="h-4 w-4" />
                  {user.name}
                </Link>
                <button
                  type="button"
                  onClick={onLogout}
                  className="flex items-center gap-2 px-3 py-3 text-sm rounded-lg hover:bg-muted transition-colors w-full text-left text-red-500"
                >
                  <LogOut className="h-4 w-4" />
                  {t("logout")}
                </button>
              </>
            ) : (
              <div className="space-y-2 px-3">
                <Link href="/auth" onClick={closeMenu}>
                  <Button className="w-full rounded-full font-semibold bg-primary hover:bg-brand-hover">
                    {t("getStarted")}
                  </Button>
                </Link>
                <Link href="/auth" onClick={closeMenu}>
                  <Button
                    variant="outline"
                    className="w-full rounded-full font-medium border-border"
                  >
                    {t("login")}
                  </Button>
                </Link>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

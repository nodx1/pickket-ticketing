"use client";

import Link from "next/link";
import { User, Bell } from "lucide-react";
import { Button } from "@pickket/ui";
import { useAuthStore } from "@pickket/store";
import { useTranslations } from "next-intl";
import LocaleSwitcher from "@/components/nav/LocaleSwitcher";

interface DesktopNavProps {
  onLogout: () => void;
}

export default function DesktopNav({ onLogout: _onLogout }: DesktopNavProps) {
  const { user } = useAuthStore();
  const t = useTranslations("nav");

  return (
    <div className="hidden md:flex items-center gap-1.5">
      <LocaleSwitcher />
      {user ? (
        <>
          <Link href="/notifications">
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 relative text-muted-foreground hover:text-foreground rounded-full"
              aria-label="알림"
            >
              <Bell className="h-3.5 w-3.5" />
            </Button>
          </Link>
          <Link href="/mypage">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-sm-minus text-muted-foreground hover:text-foreground rounded-full"
            >
              <User className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{user.name}</span>
            </Button>
          </Link>
        </>
      ) : (
        <Link href="/auth">
          <Button
            size="sm"
            className="h-8 rounded-full text-sm-minus font-semibold bg-primary hover:bg-brand-hover px-5"
          >
            {t("getStarted")}
          </Button>
        </Link>
      )}
    </div>
  );
}

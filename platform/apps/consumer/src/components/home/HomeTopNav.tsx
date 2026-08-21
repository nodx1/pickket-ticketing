"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Search,
  Bell,
  UserRound,
  Smartphone,
} from "lucide-react";
import { useAuthStore } from "@pickket/store";
import { useTranslations } from "next-intl";

export default function HomeTopNav() {
  const [scrolled, setScrolled] = useState(false);
  const [query, setQuery] = useState("");
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations("home.topNav");

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <nav
      className={`fixed top-0 w-full z-50 transition-all duration-500 ${
        scrolled
          ? "bg-violet-950/60 backdrop-blur-xl shadow-2xl shadow-purple-900/20"
          : "bg-transparent"
      }`}
    >
      <div className="flex justify-between items-center px-6 py-4 max-w-[1440px] mx-auto">
        {/* Left: Logo + Categories */}
        <div className="flex items-center gap-10">
          <Link
            href="/"
            className="flex items-center gap-2"
            aria-label={t("logoAriaLabel")}
          >
            <span className="text-2xl font-black tracking-tighter text-white uppercase">
              pickket
            </span>
            <span className="hidden sm:block text-2xs text-violet-300/60 font-medium tracking-wide">
              {t("tagline")}
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-7 text-sm-minus uppercase tracking-widest font-medium">
            <Link
              href="/fairness"
              className="text-violet-100/50 hover:text-white transition-colors py-1 min-h-[24px] flex items-center"
            >
              {t("navFairness")}
            </Link>
            <Link
              href="/support"
              className="text-violet-100/50 hover:text-white transition-colors py-1 min-h-[24px] flex items-center"
            >
              {t("navSupport")}
            </Link>
            <div className="relative group">
              <button
                type="button"
                className="text-violet-100/50 hover:text-white transition-colors py-1 min-h-[24px] flex items-center gap-1"
              >
                {t("navOrganizerEntry")}
                <svg
                  className="h-3 w-3 opacity-50 group-hover:opacity-100 transition-opacity"
                  viewBox="0 0 12 12"
                  fill="none"
                >
                  <path
                    d="M3 5l3 3 3-3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <div className="absolute top-full left-0 pt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150">
                <div className="bg-white rounded-lg shadow-lg border border-gray-200 min-w-[160px] py-1">
                  <Link
                    href="/for-organizers"
                    className="block px-5 py-3 text-sm normal-case tracking-normal text-gray-700 hover:text-black hover:bg-gray-50 transition-colors border-b border-gray-100"
                  >
                    {t("dropdownOrganizer")}
                  </Link>
                  <Link
                    href="/government"
                    className="block px-5 py-3 text-sm normal-case tracking-normal text-gray-700 hover:text-black hover:bg-gray-50 transition-colors"
                  >
                    {t("dropdownPublicReservation")}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Search + Actions */}
        <div className="flex items-center gap-3">
          <form
            className="hidden md:flex items-center bg-[var(--pk-surface)] rounded-full px-4 py-2 ring-1 ring-inset ring-[var(--pk-border-subtle)]"
            onSubmit={(e) => {
              e.preventDefault();
              const q = query.trim();
              if (q) router.push(`/events?q=${encodeURIComponent(q)}`);
            }}
          >
            <Search className="h-4 w-4 text-violet-400 mr-2" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchAriaLabel")}
              className="bg-transparent border-none text-sm focus:ring-0 focus:outline-none text-white w-40 placeholder:text-violet-100/30"
            />
          </form>

          <Link
            href="/events"
            className="md:hidden p-2 hover:bg-white/10 rounded-full transition-all"
            aria-label={t("searchAriaLabel")}
          >
            <Search className="h-5 w-5 text-violet-300" />
          </Link>

          <button
            type="button"
            className="p-2 hover:bg-white/10 rounded-full transition-all active:scale-95"
            aria-label={t("notificationAriaLabel")}
          >
            <Bell className="h-5 w-5 text-violet-300" />
          </button>

          <Link
            href={user ? "/mypage" : "/auth"}
            className="w-9 h-9 rounded-full border-2 border-violet-500/30 bg-violet-900/40 flex items-center justify-center hover:border-violet-400/60 transition-all active:scale-95"
            aria-label={user ? t("mypageAriaLabel") : t("loginAriaLabel")}
          >
            <UserRound className="h-4 w-4 text-violet-300" />
          </Link>

          {/* 앱 다운로드 CTA — 추가 */}
          <button
            type="button"
            className="hidden sm:inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold tracking-wide transition-colors active:scale-95"
          >
            <Smartphone className="h-3.5 w-3.5" />{t("appDownload")}
          </button>
        </div>
      </div>
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  FileText,
  Shield,
  RotateCcw,
  Headphones,
  Ticket,
  Landmark,
  type LucideIcon,
} from "lucide-react";

type NavLinkItem = {
  /** Translation key under "nav" namespace */
  tKey: string;
  href: string;
};

type NavDropdownChild = NavLinkItem & {
  icon: LucideIcon;
  iconColor: string;
  /** Translation key for short description */
  descKey: string;
};

type PolicyLinkItem = NavLinkItem & {
  icon: LucideIcon;
};

/** Top-level nav links (flat) */
export const NAV_LINKS: NavLinkItem[] = [
  { tKey: "about", href: "/fairness" },
  { tKey: "support", href: "/support" },
];

/** "주최자 입점" dropdown children */
export const PARTNER_LINKS: NavDropdownChild[] = [
  {
    tKey: "forOrganizers",
    descKey: "forOrganizersDesc",
    href: "/for-organizers",
    icon: Ticket,
    iconColor: "text-violet-300",
  },
  {
    tKey: "forGovernment",
    descKey: "forGovernmentDesc",
    href: "/government",
    icon: Landmark,
    iconColor: "text-emerald-300",
  },
];

export const POLICY_LINKS: PolicyLinkItem[] = [
  { tKey: "terms", href: "/terms", icon: FileText },
  { tKey: "privacy", href: "/privacy", icon: Shield },
  { tKey: "refundPolicy", href: "/refund-policy", icon: RotateCcw },
  { tKey: "support", href: "/support", icon: Headphones },
];

export function isLinkActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function DesktopNavLinks({ overlay: _overlay = false }: { overlay?: boolean }) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  const partnerActive = PARTNER_LINKS.some((l) =>
    isLinkActive(pathname, l.href),
  );

  return (
    <div className="hidden md:flex items-center gap-7 text-sm-minus font-medium tracking-wide">
      {NAV_LINKS.map((link) => {
        const active = isLinkActive(pathname, link.href);
        return (
          <Link
            key={link.tKey}
            href={link.href}
            className={`inline-flex items-center min-h-[24px] transition-colors ${
              active ? "text-white" : "text-white/60 hover:text-white"
            }`}
          >
            {t(link.tKey)}
          </Link>
        );
      })}

      {/* Partner dropdown */}
      <div className="relative group">
        <button
          type="button"
          className={`flex items-center gap-1 min-h-[24px] transition-colors ${
            partnerActive ? "text-white" : "text-white/60 hover:text-white"
          }`}
        >
          {t("forOrganizers")}
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
            {PARTNER_LINKS.map((link, i) => (
              <Link
                key={link.tKey}
                href={link.href}
                className={`block px-5 py-3 text-sm text-gray-700 hover:text-black hover:bg-gray-50 transition-colors ${
                  i < PARTNER_LINKS.length - 1 ? "border-b border-gray-100" : ""
                }`}
              >
                {t(link.tKey)}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

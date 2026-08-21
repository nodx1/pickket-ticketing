"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

export default function GuideNav() {
  const t = useTranslations("guide.nav");
  const pathname = usePathname();

  const NAV_ITEMS = [
    { href: "/guide", label: t("all") },
    { href: "/guide/booking", label: t("booking") },
    { href: "/guide/fees", label: t("fees") },
    { href: "/guide/delivery", label: t("delivery") },
    { href: "/guide/fair-booking", label: t("fairBooking") },
    { href: "/guide/seller", label: t("seller") },
    { href: "/guide/identity", label: t("identity") },
    { href: "/points", label: t("apSystem") },
  ];

  function isActive(href: string) {
    if (!pathname) return false;
    const segs = pathname.split("/");
    if (href === "/guide") return segs[segs.length - 1] === "guide";
    if (href === "/points") return segs[segs.length - 1] === "points";
    const last = href.split("/").filter(Boolean).pop() ?? "";
    return segs.includes(last);
  }

  return (
    <div className="sticky top-[60px] z-40 bg-white/90 backdrop-blur-sm border-b border-gray-100">
      <div className="max-w-[1440px] mx-auto px-10">
        <div className="flex items-center gap-1 py-2.5 overflow-x-auto scrollbar-hide">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition-all duration-200 ${
                isActive(item.href)
                  ? "bg-gray-900 text-white"
                  : "text-gray-400 hover:text-gray-900 hover:bg-gray-100"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";
import {
  Ticket,
  Coins,
  Smartphone,
  ShieldCheck,
  Store,
  UserCheck,
  Zap,
  ArrowRight,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

const GUIDE_KEYS = [
  {
    num: "01",
    href: "/guide/booking",
    icon: Ticket,
    titleKey: "guides.booking.title",
    descKey: "guides.booking.description",
    timeKey: "guides.booking.time",
  },
  {
    num: "02",
    href: "/guide/fees",
    icon: Coins,
    titleKey: "guides.fees.title",
    descKey: "guides.fees.description",
    timeKey: "guides.fees.time",
  },
  {
    num: "03",
    href: "/guide/delivery",
    icon: Smartphone,
    titleKey: "guides.delivery.title",
    descKey: "guides.delivery.description",
    timeKey: "guides.delivery.time",
  },
  {
    num: "04",
    href: "/guide/fair-booking",
    icon: ShieldCheck,
    titleKey: "guides.fairBooking.title",
    descKey: "guides.fairBooking.description",
    timeKey: "guides.fairBooking.time",
  },
  {
    num: "05",
    href: "/guide/seller",
    icon: Store,
    titleKey: "guides.seller.title",
    descKey: "guides.seller.description",
    timeKey: "guides.seller.time",
  },
  {
    num: "06",
    href: "/guide/identity",
    icon: UserCheck,
    titleKey: "guides.identity.title",
    descKey: "guides.identity.description",
    timeKey: "guides.identity.time",
  },
  {
    num: "07",
    href: "/points",
    icon: Zap,
    titleKey: "guides.ap.title",
    descKey: "guides.ap.description",
    timeKey: "guides.ap.time",
  },
];

const JOURNEY_KEYS = [
  {
    step: "01",
    titleKey: "journey.register.title",
    subKey: "journey.register.sub",
    href: "/guide/identity",
  },
  {
    step: "02",
    titleKey: "journey.explore.title",
    subKey: "journey.explore.sub",
    href: "/events",
  },
  {
    step: "03",
    titleKey: "journey.apply.title",
    subKey: "journey.apply.sub",
    href: "/guide/booking",
  },
  {
    step: "04",
    titleKey: "journey.enter.title",
    subKey: "journey.enter.sub",
    href: "/guide/delivery",
  },
];

export default async function GuidePage() {
  const t = await getTranslations("guide.index");
  return (
    <div className="bg-white min-h-screen pt-20">
      {/* ─── Hero ─────────────────────────────────────────── */}
      <section className="bg-white border-b border-gray-100 pt-16 pb-14">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-10">
          <p className="text-xs font-bold tracking-[0.18em] uppercase text-gray-500 mb-5">
            {t("hero.eyebrow")}
          </p>
          <h1 className="text-4xl sm:text-[4.5rem] font-black tracking-tight text-gray-900 leading-[0.95]">
            {t("hero.headlineLine1")}
            <br />
            {t("hero.headlineLine2")}
          </h1>
        </div>
      </section>

      {/* ─── 추천 여정 ────────────────────────────────────── */}
      <section className="bg-gray-950">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-10 py-10">
          <p className="text-xs font-bold tracking-[0.16em] uppercase text-white/25 mb-6">
            {t("journey.label")}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-white/10 border border-white/10 rounded-xl overflow-hidden">
            {JOURNEY_KEYS.map((item) => (
              <Link
                key={item.step}
                href={item.href}
                className="group bg-white/[0.03] hover:bg-white/[0.08] transition-colors duration-200 px-4 sm:px-7 py-7 min-h-[88px]"
              >
                <span className="text-xs font-black text-white/40 block mb-5">
                  {item.step}
                </span>
                <p className="text-[18px] font-bold text-white leading-none mb-1.5">
                  {t(item.titleKey)}
                </p>
                <p className="text-[12px] text-white/55 mt-1">{t(item.subKey)}</p>
                <ArrowRight className="w-3.5 h-3.5 text-white/30 group-hover:text-white/70 mt-5 group-hover:translate-x-0.5 transition-all duration-200" />
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ─── 가이드 목록 ──────────────────────────────────── */}
      <section className="py-14">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-10">
          <div className="flex items-baseline justify-between mb-8">
            <p className="text-xs font-bold tracking-[0.16em] uppercase text-gray-500">
              {t("list.label", { count: GUIDE_KEYS.length })}
            </p>
            <p className="text-xs text-gray-500 hidden sm:block">
              {t("list.tagline")}
            </p>
          </div>

          <div className="divide-y divide-gray-100">
            {GUIDE_KEYS.map((guide) => {
              const Icon = guide.icon;
              return (
                <Link
                  key={guide.href}
                  href={guide.href}
                  className="group grid grid-cols-[3rem_1fr_auto] lg:grid-cols-[3rem_2.5rem_1fr_minmax(0,480px)_5rem_2rem] items-center gap-x-5 py-5 hover:bg-gray-50 -mx-4 px-4 rounded-xl transition-colors duration-150"
                >
                  {/* 번호 */}
                  <span className="text-xs font-black text-gray-200 group-hover:text-gray-400 transition-colors select-none">
                    {guide.num}
                  </span>

                  {/* 아이콘 — hidden on mobile */}
                  <div className="hidden lg:flex w-9 h-9 rounded-xl bg-gray-100 group-hover:bg-gray-200 transition-colors items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                  </div>

                  {/* 타이틀 */}
                  <p className="text-[15px] font-bold text-gray-900">
                    {t(guide.titleKey)}
                  </p>

                  {/* 설명 — hidden on mobile */}
                  <p className="hidden lg:block text-[12px] text-gray-500 truncate">
                    {t(guide.descKey)}
                  </p>

                  {/* 읽기 시간 */}
                  <span className="hidden lg:block text-[11px] text-gray-300 text-right">
                    {t("list.readTime", { time: t(guide.timeKey) })}
                  </span>

                  {/* 화살표 */}
                  <ArrowRight className="w-4 h-4 text-gray-200 group-hover:text-gray-700 dark:text-gray-300 group-hover:translate-x-0.5 transition-all duration-200 justify-self-end" />
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* ─── 하단 CTA ─────────────────────────────────────── */}
      <section className="border-t border-gray-100 py-10">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="text-[14px] font-semibold text-gray-900">
              {t("cta.question")}
            </p>
            <p className="text-[12px] text-gray-500 mt-0.5">
              {t("cta.sub")}
            </p>
          </div>
          <Link
            href="/support"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-gray-900 text-white text-[12px] font-bold hover:bg-gray-800 transition-colors"
          >
            {t("cta.button")}
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </section>
    </div>
  );
}

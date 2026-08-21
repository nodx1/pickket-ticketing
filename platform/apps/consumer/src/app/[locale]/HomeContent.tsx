import Link from "next/link";
import { ArrowRight, Flame } from "lucide-react";
import { useTranslations } from "next-intl";
import AppDownloadSection from "@/components/home/AppDownloadSection";
import B2BCTABanner from "@/components/home/B2BCTABanner";
import EventCardUnified from "@/components/event/EventCardUnified";
import FanRequestSection from "@/components/home/FanRequestSection";
import HeroCarousel from "@/components/home/HeroCarousel";
import ManifestoSection from "@/components/home/ManifestoSection";
import type { HomeContentProps } from "@/components/home/types";

const W = "max-w-[1440px] mx-auto px-4 sm:px-10";

export default function HomeContent({
  trendingEvents,
  featuredEvents,
  trendingRaw,
  fanRequests,
}: HomeContentProps) {
  const t = useTranslations("home");

  return (
    <div className="min-h-screen bg-background text-foreground overflow-clip">
      {/* ── 히어로 (기존 유지) */}
      <HeroCarousel
        events={[
          ...featuredEvents,
          ...trendingEvents
            .filter((e) => !featuredEvents.some((f) => f.id === e.id))
            .slice(0, 3),
        ]}
      />

      {/* ── 인기 행사 그리드 (이벤트 있을 때만) */}
      {(trendingRaw ?? []).length > 0 && (
        <>
          <section className={`${W} pt-20 pb-16`}>
            <div className="flex items-end justify-between mb-10">
              <div>
                <p className="text-xs font-bold tracking-[0.12em] uppercase text-violet-600 dark:text-violet-400 mb-2 flex items-center gap-1.5">
                  <Flame className="h-3 w-3" />
                  {t("trending_eyebrow")}
                </p>
                <h2 className="text-3xl font-black tracking-tight text-foreground">
                  {t("trending_heading")}
                </h2>
              </div>
              <Link
                href="/events"
                className="inline-flex items-center gap-1.5 min-h-[24px] text-[13px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("view_all")}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {(trendingRaw ?? []).slice(0, 8).map((event) => (
                <EventCardUnified key={event.id} event={event} />
              ))}
            </div>
          </section>

          <div className="border-t border-gray-100 max-w-[1440px] mx-auto" />
        </>
      )}

      {/* ── 공정성 약속 */}
      <ManifestoSection />

      {/* ── 팬 요청 */}
      <FanRequestSection artists={fanRequests} />

      {/* ── 앱 다운로드 (App Exclusive) */}
      <AppDownloadSection />

      {/* ── B2B CTA */}
      <B2BCTABanner />
    </div>
  );
}

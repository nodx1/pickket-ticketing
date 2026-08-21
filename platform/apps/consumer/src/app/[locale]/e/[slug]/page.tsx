/**
 * /e/[slug] — 티켓오픈 알림 랜딩 페이지
 *
 * Pickket 4대 약속 P6 "티켓오픈 우선주의" 구현체.
 * DICE FM의 full-bleed hero + Laylo의 단일 CTA / 거대 카운트다운 DNA 흡수.
 *
 * 디자인 근거: docs/design/DICE_LAYLO_UI_ABSORPTION_2026-04-09.md §2
 * 정책 근거: docs/plans/10_POLICY_HANDBOOK.md P6 (국내 조정안)
 * 마스터 플랜: docs/plans/12_MASTER_DEVELOPMENT_PLAN_2026-04-09.md §3.2
 *
 * @status PROTOTYPE (2026-04-09) — 목업 데이터 기반. API 연결은 S3에서.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { EventOpenHero } from "./_components/EventOpenHero";
import { EventOpenCountdown } from "./_components/EventOpenCountdown";
import { EventOpenSubscribeButton } from "./_components/EventOpenSubscribeButton";
import { getEventOpenBySlug } from "./_data";
import { PromiseMicroStrip } from "@/components/PromiseMicroStrip";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const event = await getEventOpenBySlug(slug);
  if (!event) return { title: "티켓오픈 알림 | Pickket" };

  return {
    title: `${event.title} 티켓오픈 알림 | Pickket`,
    description: `${event.title} 티켓오픈 순간, 가장 먼저 알려드립니다. 취소표는 액면가 그대로.`,
    openGraph: {
      title: `${event.title} 티켓오픈 알림`,
      description: "표 놓쳐도 괜찮아요. Pickket이 다시 드릴게요.",
      images: [`/api/og/event-open?slug=${slug}`],
    },
  };
}

export default async function EventOpenLandingPage({ params }: Props) {
  const { locale, slug } = await params;
  const event = await getEventOpenBySlug(slug);
  if (!event) notFound();
  const t = await getTranslations("event.openLanding");

  // live 판정 — 티켓오픈 시각이 지났거나(미설정 포함) 판매중 상태면 이미 오픈.
  // EventOpenCountdown 의 isLive 조건(target NaN/과거)과 동일하게 맞춰 카운트다운과 CTA 가 어긋나지 않게 함.
  const openAt = event.ticketOpenAt ? new Date(event.ticketOpenAt) : null;
  const openReached =
    !openAt || Number.isNaN(openAt.getTime()) || openAt.getTime() <= Date.now();
  const SELLING_STATUSES = new Set([
    "bidding_open",
    "open",
    "on_sale",
    "selling",
    "fcfs_open",
  ]);
  const isLive = openReached || SELLING_STATUSES.has(event.status);

  // 주최자 브랜드 컬러 전역 주입 (Laylo DNA)
  const themeStyle = {
    "--event-accent": event.brandColor,
    "--event-accent-fg": event.brandColorFg,
  } as React.CSSProperties;

  return (
    <main
      data-event-theme
      style={themeStyle}
      className="relative min-h-[100svh] w-full overflow-hidden bg-[#0A0A0A] text-white"
    >
      {/* Full-bleed hero (DICE DNA) */}
      <EventOpenHero
        imageUrl={event.heroImage}
        imageVariants={event.imageVariants}
        title={event.title}
        venue={event.venue}
        openDate={event.ticketOpenAt ?? ""}
        isLive={isLive}
      />

      {/* 거대 카운트다운 (Laylo DNA) */}
      <section className="relative z-10 mx-auto flex w-full max-w-screen-sm flex-col items-center gap-8 px-6 pt-8 pb-16 text-center">
        <EventOpenCountdown targetIso={event.ticketOpenAt ?? ""} />

        {/* 오픈 전: 알림 신청 / 오픈됨(live): 예매 페이지(/events/[id])로 유도.
            기존엔 live 여부와 무관하게 '알림 받기'만 떠서, 이미 판매중인데도 구매 경로가 없었다. */}
        {isLive ? (
          <Link
            href={`/${locale}/events/${event.id}`}
            className="inline-flex w-full max-w-xs items-center justify-center rounded-2xl px-8 py-4 text-lg font-bold shadow-lg transition-transform hover:scale-[1.02]"
            style={{
              background: "var(--event-accent)",
              color: "var(--event-accent-fg)",
            }}
          >
            예매하러 가기 →
          </Link>
        ) : (
          <EventOpenSubscribeButton
            eventId={event.id}
            eventTitle={event.title}
            subscriberCount={event.subscriberCount}
          />
        )}

        <p className="max-w-xs text-sm leading-relaxed text-white/60">
          {t("noticeSchedule")}
        </p>
      </section>

      {/* Trust strip */}
      <div className="text-center py-6">
        <PromiseMicroStrip variant="dark" className="text-xs" />
      </div>

      {/* Pickket footer — 브랜드는 숨는다 (Laylo 원칙) */}
      <footer className="relative z-10 pb-8 text-center text-xs text-white/40">
        powered by <span className="font-semibold">Pickket</span>
      </footer>
    </main>
  );
}

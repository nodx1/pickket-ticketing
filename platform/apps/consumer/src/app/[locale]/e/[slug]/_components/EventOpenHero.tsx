/**
 * EventOpenHero — Full-bleed 히어로 (DICE DNA)
 *
 * 카드 chrome 없음, 이미지 전체가 배경, 텍스트는 이미지 위에 직접.
 * 하단 그라디언트 오버레이로 텍스트 가독성 확보.
 *
 * Note: 프로토타입 단계에서는 background-image로 외부 이미지 직접 렌더.
 *       S3에서 R2/CloudFront 이미지로 교체되면 next/image 전환.
 */

import { getTranslations } from "next-intl/server";
import { pickImage } from "@pickket/lib";

type Props = {
  imageUrl: string;
  imageVariants?: Record<string, string> | null;
  title: string;
  venue: string;
  openDate: string;
  isLive?: boolean;
};

const DATE_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export async function EventOpenHero({ imageUrl, imageVariants, title, venue, openDate, isLive }: Props) {
  const t = await getTranslations("event.openHero");
  // Full-bleed wide 히어로 → wide 렌디션 우선, 그다음 image_url.
  const heroSrc = pickImage(imageVariants, "wide", imageUrl) ?? imageUrl;
  // openDate 가 비었거나(ticket_open_at=null) 파싱 불가면 new Date()가 Invalid Date →
  // Intl.DateTimeFormat.format()이 RangeError 를 던져 SSR 전체가 크래시한다. 유효할 때만 표기.
  const parsedOpen = openDate ? new Date(openDate) : null;
  const openDateValid = parsedOpen !== null && !Number.isNaN(parsedOpen.getTime());
  return (
    <section
      className="relative h-[68svh] w-full bg-cover bg-center"
      style={{ backgroundImage: `url(${heroSrc})` }}
      aria-label={title}
    >
      {/* 그라디언트 오버레이 (하단 텍스트 가독성) */}
      <div
        className="absolute inset-0 bg-gradient-to-b from-transparent via-black/40 to-[#0A0A0A]"
        aria-hidden
      />

      {/* 브랜드 컬러 그라디언트 워시 (Laylo DNA) */}
      <div
        className="absolute inset-0 mix-blend-soft-light opacity-60"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--event-accent) 0%, transparent 70%)",
        }}
        aria-hidden
      />

      {/* Hero 텍스트 */}
      <div className="absolute inset-x-0 bottom-0 z-10 mx-auto flex max-w-screen-sm flex-col items-center px-6 pb-10 text-center">
        <p className="mb-3 text-sm font-medium uppercase tracking-[0.2em] text-white/70">
          {/* live 면 '예정' 대신 판매중 표기 — 카운트다운/CTA 와 문구 정합. */}
          {isLive ? "지금 예매 중" : t("ticketOpenSoon")}
        </p>
        <h1
          className="font-[var(--font-pretendard,Pretendard)] text-[clamp(2.25rem,7vw,4.5rem)] font-black leading-[1.05] tracking-tight"
          style={{ textShadow: "0 2px 24px rgba(0,0,0,0.5)" }}
        >
          {title}
        </h1>
        <p className="mt-4 text-base text-white/80">{venue}</p>
        {!isLive && openDateValid && parsedOpen && (
          <p className="mt-1 text-sm text-white/60">
            {t("opensAt", { date: DATE_FORMAT.format(parsedOpen) })}
          </p>
        )}
      </div>
    </section>
  );
}

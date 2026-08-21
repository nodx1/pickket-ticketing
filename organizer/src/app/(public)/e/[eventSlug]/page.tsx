import type { Metadata } from "next";
import { strikethroughPrice } from "@/lib/public/face-price";
import { buildEventSeoTitles, SITE_NAME } from "@/lib/seo/site";
import { normalizeEventSlug } from "@/lib/public/event-slug";
import { resolveIntroText, showsIntroSection } from "@/lib/public/intro-text";
import { isEventSoldOut, type SoldOutProduct } from "@/lib/public/sold-out";
import { resolveEventTabs } from "@/lib/public/event-tabs";
import { showsHeroOverlay } from "@/lib/public/hero-overlay";
import { toGalleryViews } from "@/lib/public/gallery-item";
import { DETAIL_SECTION_LABELS, detailImagesFor, toDetailImageViews } from "@/lib/public/detail-image";
import { toOrganizerLines } from "@/lib/public/organizer-lines";
import { EventDetailTabs } from "./_components/event-detail-tabs";
import { GalleryLightbox } from "./_components/gallery-lightbox";
import { DetailImageBox, DetailSectionCard } from "./_components/detail-images";
import Link from "next/link";
import { CalendarDays, Clock, MapPin, RefreshCcw, Shield, Smartphone, Ticket } from "lucide-react";
import { notFound } from "next/navigation";
import { VenueMap } from "./_components/venue-map";
import { CountdownTimer } from "./_components/countdown-timer";
import { StickyCTABar } from "./_components/sticky-cta-bar";
import { AGE_RATING_LABELS, EVENT_TYPE_LABELS } from "@/lib/constants";
import { formatDate, formatKRW } from "@/lib/format";
import { getPublicEventBySlug } from "@/lib/server/events";
import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { AffiliateRefTracker } from "./_components/affiliate-ref-tracker";
import { ContextBanner } from "./_components/context-banner";
import { QueuePurchaseGate } from "./_components/queue-purchase-gate";
import { RsvpForm } from "./_components/rsvp-form";
import { InquiryForm } from "./_components/inquiry-form";

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ eventSlug: string }>;
}): Promise<Metadata> {
  const { eventSlug: rawSlug } = await params;
  const eventSlug = (() => {
    try {
      return decodeURIComponent(rawSlug);
    } catch {
      return rawSlug;
    }
  })();
  const event = await getPublicEventBySlug(eventSlug, { includeSeats: false });

  if (!event) {
    // 브랜드명을 쓰지 않는다 — 루트 layout 의 `title.template` 이 붙인다.
    return {
      title: "이벤트를 찾을 수 없습니다",
    };
  }

  const seo =
    event.seoMetadata &&
    typeof event.seoMetadata === "object" &&
    !Array.isArray(event.seoMetadata)
      ? (event.seoMetadata as {
          seoTitle?: string;
          seoDescription?: string;
          ogTitle?: string;
          ogDescription?: string;
          keywords?: string[];
        })
      : {};
  // 🔴 종전엔 여기서 `${event.title} — PICKKET.GO` 를 만들었다. 루트 template 이 브랜드를
  //    **한 번 더** 붙여 `… — PICKKET.GO — PICKKET.GO` 가 됐다(og:title 은 template 을
  //    안 타서 멀쩡했고, 그 비대칭이 원인을 확정해 줬다).
  const { title, ogTitle } = buildEventSeoTitles({
    eventTitle: String(event.title),
    seoTitle: seo.seoTitle,
    ogTitle: seo.ogTitle,
  });
  const description = (
    seo.seoDescription ??
    // ⚠️ 여기는 `<meta name="description">` 이라 **폴백이 필요하다**(검색엔진에 빈 값을 주면 안 된다).
    //    다만 빈 문자열 판정은 화면과 **같은 함수**로 한다 — `??` 만 쓰면 `""` 를 그대로 내보낸다.
    resolveIntroText((event as { summary?: unknown }).summary, event.description) ??
    "PICKKET.GO에서 이벤트 티켓을 예약하세요."
  ).slice(0, 160);
  const ogDescription = (seo.ogDescription ?? description).slice(0, 160);
  const image = typeof event.heroImageUrl === "string" ? event.heroImageUrl : undefined;
  const ogImageUrl = `/api/events/${String(event.id)}/og-image`;

  return {
    title,
    description,
    keywords: seo.keywords,
    openGraph: {
      title: ogTitle,
      description: ogDescription,
      type: "website",
      // 🔴 자식의 openGraph 는 부모를 **교체**한다(병합이 아니다). 이 두 줄이 없으면
      //    루트 layout 이 설정한 og:site_name·og:locale 이 **사라진다** — prod 실측으로
      //    확인했다(랜딩에는 있고 이벤트 페이지에는 없었다). 공유 카드에서 사이트명이 빠진다.
      siteName: SITE_NAME,
      locale: "ko_KR",
      images: image ? [{ url: image }] : [{ url: ogImageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description: ogDescription,
      images: image ? [image] : [ogImageUrl],
    },
  };
}

export default async function PublicEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventSlug: string }>;
  searchParams: Promise<{ ref?: string }>;
}) {
  const { eventSlug: rawSlug } = await params;
  // 한글 슬러그 방어 — 하위 라우트 7개와 **같은 규칙**을 쓰도록 공용 헬퍼로 통일했다
  // (이 페이지에만 있고 checkout 계열엔 없어서 구매 경로가 전면 404 였다).
  const eventSlug = normalizeEventSlug(rawSlug);
  const { ref } = await searchParams;
  const event = await getPublicEventBySlug(eventSlug, { includeSeats: false });

  if (!event) {
    notFound();
  }
  const hpDesign = (event.homepageDesign ?? {}) as {
    coverImageUrl?: string;
    heroHeadline?: string;
    heroSubtext?: string;
    ctaText?: string;
    sectionDescriptions?: Record<string, string>;
    accentColor?: string;
    templateId?: string;
    showCountdown?: boolean;
    showVenueMap?: boolean;
    showOrganizer?: boolean;
    backgroundColor?: string;
    textColor?: string;
    heroFit?: "cover" | "contain";
    /** 히어로 위에 제목·배지·어둠막을 얹을지. 포스터에 이미 글자가 있으면 끈다(기본 true). */
    heroOverlay?: boolean;
    /** 소개 본문 아래에 세로로 이어 붙이는 상세 안내 이미지. 구조 검증은 toDetailImageViews 가 한다. */
    detailImages?: unknown;
    /** 환불 안내 자유문구 — 주최자가 환불 정책 화면에서 직접 쓴다. */
    refundNotice?: string;
  };
  // 히어로 배경 우선순위: 디자이너 커버 → wide 렌디션(16:9 최적화) → 원본 hero_image_url.
  // 기존엔 coverImageUrl(디자이너 전용)만 읽어 미설정 시 무이미지로 렌더됐다.
  const wideRendition =
    (event.imageVariants as Record<string, string> | null | undefined)?.wide;
  const portraitRendition =
    (event.imageVariants as Record<string, string> | null | undefined)?.portrait;
  // 데스크탑 히어로: 디자이너 커버 → wide(16:9) → 원본.
  const coverImageUrl =
    (typeof hpDesign.coverImageUrl === "string" && hpDesign.coverImageUrl) ||
    wideRendition ||
    (typeof event.heroImageUrl === "string" ? event.heroImageUrl : "");
  // 모바일 히어로: 디자이너 커버 → portrait(3:4, 세로화면 최적) → wide → 원본.
  // (세로 폰에서 16:9 wide 는 좌우가 심하게 크롭됨 → portrait 우선.)
  const mobileCoverImageUrl =
    (typeof hpDesign.coverImageUrl === "string" && hpDesign.coverImageUrl) ||
    portraitRendition ||
    coverImageUrl;
  const heroGradient =
    "linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, transparent 28%, transparent 42%, rgba(0,0,0,0.55) 74%, rgba(0,0,0,0.92) 100%)";
  // 전체표시 모드: 완성형 포스터(글자 포함)를 잘림 없이 다 보이게(contain) + 블러 배경필.
  const heroContain = hpDesign.heroFit === "contain";
  // 🔴 히어로 오버레이(제목·배지 + 가독성용 어둠막).
  //   완성형 포스터(글자·날짜가 이미 박힌 이미지)에는 **중복이자 훼손**이다.
  //   어둠막은 흰 배경을 회색으로 만든다 — 실측: 이미지 RGB(255,255,253) → 화면 RGB(195,196,196).
  //   주최자가 흰 배경 포스터를 올렸는데 회색으로 게시되는 건 브랜드 훼손이라 끌 수 있어야 한다.
  //   끄면 제목·배지는 **히어로 아래 일반 텍스트로 옮긴다** — 숨기면 SEO·접근성이 같이 사라진다.
  const heroOverlay = showsHeroOverlay(hpDesign.heroOverlay);
  // 갤러리 — 캡션 정규화·alt 결정은 순수 함수에 둔다(서버 컴포넌트 안에 두면 테스트가 닿지 못한다).
  const galleryViews = toGalleryViews(event.galleryImages, String(event.title));
  // 상세 이미지 — 소개 본문 아래에 세로로 이어 붙인다. homepage_design JSONB 에 산다.
  // 환불 정책 — 실제 지급액 계산과 **같은 출처**(v2 cancellation_fee_tiers)에서 문구를 만든다.
  // 🔴 필드명은 `cancellationPolicy` 이고 **이미 camelCase 로 변환**돼 온다
  //    (`event-view.ts:toGoCancellationPolicy` → `{daysBefore, feePct}`).
  //    2026-07-31: 처음에 `cancellationFeeTiers`/`cancellation_fee_tiers` 로 찾아 **항상 빈 배열**이
  //    됐고, 규정이 있는 행사에 "환불 규정이 설정되지 않았습니다" 가 떴다 — 코드만 보고
  //    필드명을 짐작한 결과다. 실제 응답(`/api/public/events/{slug}`)을 찍어보고 고쳤다.
  // 환불 안내 자유문구 — 주최자가 **환불 정책 화면에서 직접** 쓴 값(`homepage_design.refundNotice`).
  // 🔴 공지(`open_notices`)를 끌어오는 방식은 폐기했다: 쓰는 화면과 보는 화면이 갈라져
  //    주최자가 "환불 규정을 쓰는데 공지사항으로 가라" 는 상태가 됐다(대표 지적).
  //    저장·편집·표시가 전부 환불 정책 한 곳에서 끝나야 한다.
  const refundNotice = String(hpDesign.refundNotice ?? "").trim();

  const refundPolicyLines = toRefundPolicyLines(
    (event as { cancellationPolicy?: Array<{ daysBefore: number; feePct: number }> | null })
      .cancellationPolicy ?? [],
  );
  const detailImages = toDetailImageViews(hpDesign.detailImages, String(event.title));

  // 소개 본문·이미지 — 빈 값 판정은 `resolveIntroText` 한 곳에서만 한다.
  const introText = resolveIntroText(event.description, (event as { summary?: unknown }).summary);
  const introImages = detailImagesFor(detailImages, "intro");

  const heroHeadline =
    typeof hpDesign.heroHeadline === "string" ? hpDesign.heroHeadline : "";
  const heroSubtext =
    typeof hpDesign.heroSubtext === "string" ? hpDesign.heroSubtext : "";
  const ctaText = typeof hpDesign.ctaText === "string" ? hpDesign.ctaText : "";
  const sectionDescriptions = (hpDesign.sectionDescriptions ?? {}) as Record<string, string>;
  const ageVariant =
    event.ageRating === "18+" ? "bg-destructive/15 text-destructive" :
    event.ageRating === "15+" ? "bg-warning/15 text-warning" :
    event.ageRating === "12+" ? "bg-info/15 text-info" :
    "bg-success/15 text-success";

  const prices = event.products.map((p: { price: number | string }) => Number(p.price ?? 0));
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  // 매진 판정은 `lib/public/sold-out.ts` 의 순수 함수가 정본이다.
  // 🔴 여기 인라인으로 두면 서버 컴포넌트라 **어떤 테스트도 닿지 못한다** — 감사가
  //    판정을 정반대로 뒤집는 뮤테이션을 넣었는데 1220개 테스트가 전부 통과했다(F-3).
  const isSoldOut = isEventSoldOut(event.products as SoldOutProduct[]);

  // 정보 영역을 탭으로 묶는다. **내용이 있는 탭만** 노출한다 — 빈 탭은 "준비 중"만 보이는
  // 페이지가 된다. 판정은 순수 함수(테스트 대상)에 위임한다.
  const schedules =
    (event as { schedules?: Array<{ id: string; title: string; startsAt: string; venueName: string | null; description: string | null; imageUrl?: string | null }> })
      .schedules ?? [];
  // 프로그램 탭 자유문구 — 판정과 렌더가 **같은 값**을 보게 한 곳에서 꺼낸다.
  const introPrograms = {
    programNotes: (event as { programNotes?: string | null }).programNotes ?? null,
    stageInfo: (event as { stageInfo?: string | null }).stageInfo ?? null,
  };

  const eventTabs = resolveEventTabs({
    description: event.description as string | null,
    summary: event.summary as string | null,
    scheduleCount: schedules.length,
    venueAddress: event.venueAddress as string | null,
    transportInfo: (event as { transportInfo?: string | null }).transportInfo ?? null,
    parkingInfo: (event as { parkingInfo?: string | null }).parkingInfo ?? null,
    // 🔴 종전엔 이 둘을 안 넘겨서 프로그램 탭이 **일정(scheduleCount)으로만** 켜졌다.
    //    `event-tabs.ts` 는 처음부터 이 입력을 선언하고 있었다 — 공급만 없었다.
    programNotes: introPrograms.programNotes,
    stageInfo: introPrograms.stageInfo,
    showVenueMap: hpDesign.showVenueMap ?? null,
  });

  // 주최자 표시 — 역할을 **행으로 나눈다**(순수 함수). 종전에는 값에 역할명이 붙어
  // "주최자 / 주최 비씨카드" 로 두 번 나왔다(2026-07-30 주최측 지적).
  const organizerLines = toOrganizerLines(event.organizers, event.organizerName);

  return (
    <div
      className="min-h-screen"
      style={{
        backgroundColor: String((event.homepageDesign as { backgroundColor?: string } | undefined)?.backgroundColor ?? "#FAFBFF"),
        color: String((event.homepageDesign as { textColor?: string } | undefined)?.textColor ?? "#1A1D2E"),
      }}
    >
      <AffiliateRefTracker code={ref ?? null} />
      <ContextBanner eventId={String(event.id)} />

      {/* ── 히어로 섹션 ── */}
      {/* 🔴 높이 고정(min-h) → **비율 고정**으로 바꿨다.
       *
       * 종전에는 높이가 560px 로 못박혀 있고 폭만 화면을 따라가서, **화면마다 다른 비율의 상자**가 됐다:
       *      768px  → 1.75:1   (16:9 이미지 잘림 0%)
       *     1440px  → 2.57:1   (31% 잘림)
       *     1920px  → 3.43:1   (48% 잘림)
       * 그래서 어떤 비율로 이미지를 만들어 넣어도 **어떤 화면에서는 반드시 잘렸다** —
       * 주최자가 "규격에 맞춰 올린다" 는 게 성립할 수 없는 구조였다(맞출 규격이 없다).
       *
       * 비율을 고정하면 모든 화면에서 같은 모양이 되고, 그 비율로 만든 이미지는 어디서도 안 잘린다.
       * 값은 실기기 뷰포트로 계산해 정했다(히어로+헤더가 첫 화면에서 차지하는 비율):
       *      16:9  맥북 97% · FHD 109%  → 첫 화면을 다 먹거나 넘침
       *      21:9  맥북 76% · FHD  85%  → 아래 내용이 걸쳐 보여 스크롤 유도가 자연스럽다
       * 모바일에서 21:9 는 168px 띠가 되므로 세로 3:4 를 따로 쓴다.
       */}
      <div
        className={`relative flex flex-col items-center justify-end overflow-hidden ${heroOverlay ? "pb-8" : ""} aspect-[3/4] w-full sm:aspect-[21/9]`}
        style={
          !coverImageUrl
            ? { backgroundImage: "linear-gradient(135deg, rgba(108,92,231,0.12) 0%, rgba(139,92,246,0.08) 50%, rgba(5,150,105,0.06) 100%)" }
            : undefined
        }
      >
        {coverImageUrl ? (
          <>
            {heroContain ? (
              /* 포스터 모드 — 주최자가 올린 포스터를 **잘림 없이** 보여준다.
                 이미지 비율은 고정이라 "잘림 없음 · 좌우 꽉 · 높이 적당" 셋을 동시에 만족할 수
                 없다(16:9 를 폭 1920 에 꽉 채우면 높이가 1080 으로 정해진다). 그래서:
                   · 폭 상한 1600px — 초광폭에서 히어로가 첫 화면을 통째로 먹지 않게 한다.
                   · 남는 좌우는 **페이지 배경색** 그대로 둔다(블러 배경은 지저분해 걷어냈다).
                     포스터가 배경 위에 놓인 형태라 오히려 정돈돼 보인다.
                   · 모바일(sm 미만): 세로 3:4 + portrait 렌디션 — 손에 들었을 때 크게 보인다.
                 ⚠️ 높이 상한(max-h)은 걸지 않는다 — 걸면 포스터가 그 높이에 맞춰 축소되면서
                    좌우 여백이 급격히 커진다(max-h-620 으로 만들었다가 되돌린 이력). */
              <>
                {/* 포스터 — 모바일은 세로, 그 위는 wide. 여백은 페이지 배경색이 그대로 보인다. */}
                <div
                  aria-hidden
                  className="absolute inset-0 bg-contain bg-center bg-no-repeat sm:hidden"
                  style={{ backgroundImage: `url(${mobileCoverImageUrl})` }}
                />
                <div
                  aria-hidden
                  className="absolute inset-0 hidden bg-contain bg-center bg-no-repeat sm:block"
                  style={{ backgroundImage: `url(${coverImageUrl})` }}
                />
              </>
            ) : (
              <>
                {/* 모바일: portrait 렌디션(세로 최적) */}
                <div
                  aria-hidden
                  className="absolute inset-0 bg-cover bg-[center_35%] lg:hidden"
                  style={{ backgroundImage: `url(${mobileCoverImageUrl})` }}
                />
                {/* 데스크탑: wide cover 크롭 */}
                <div
                  aria-hidden
                  className="absolute inset-0 hidden bg-cover bg-[center_35%] lg:block"
                  style={{ backgroundImage: `url(${coverImageUrl})` }}
                />
              </>
            )}
            {/* 타이틀 가독성 다크 그라디언트 — **오버레이를 얹을 때만** 깐다.
                이 막이 흰 배경을 회색으로 만든다(실측 255→195). 얹을 글자가 없으면 깔 이유도 없다. */}
            {heroOverlay ? (
              <div aria-hidden className="absolute inset-0" style={{ backgroundImage: heroContain
                ? "linear-gradient(to bottom, transparent 0%, transparent 60%, rgba(0,0,0,0.45) 88%, rgba(0,0,0,0.82) 100%)"
                : heroGradient }} />
            ) : null}
          </>
        ) : null}
        {heroOverlay ? (
        <div className="relative z-10 mx-auto w-full max-w-5xl px-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary/20 px-3 py-1 text-sm font-medium text-white backdrop-blur-md">
              {EVENT_TYPE_LABELS[event.eventType as keyof typeof EVENT_TYPE_LABELS] ?? String(event.eventType)}
            </span>
            <span className={`rounded-full px-3 py-1 text-sm font-medium backdrop-blur-md ${ageVariant}`}>
              {event.ageRating === "18+" ? "18세 이상" : AGE_RATING_LABELS[event.ageRating as keyof typeof AGE_RATING_LABELS] ?? String(event.ageRating)}
            </span>
          </div>
          <h1
            className={`mt-4 text-3xl font-black leading-[1.1] tracking-[-0.04em] sm:text-4xl lg:text-6xl ${coverImageUrl ? "text-white" : "text-foreground"}`}
            style={coverImageUrl ? { textShadow: "0 2px 20px rgba(0,0,0,0.6)" } : undefined}
          >
            {heroHeadline || String(event.title)}
          </h1>
          {heroSubtext ? (
            <p
              className={`mt-3 max-w-2xl text-base ${coverImageUrl ? "text-white/85" : "text-muted-foreground"}`}
              style={coverImageUrl ? { textShadow: "0 1px 10px rgba(0,0,0,0.6)" } : undefined}
            >
              {heroSubtext}
            </p>
          ) : null}
        </div>
        ) : null}
      </div>

      {/* 오버레이를 끈 경우 — 제목·배지를 히어로 **아래** 일반 텍스트로 둔다.
          숨기기만 하면 h1 이 사라져 검색·화면낭독기가 행사명을 못 읽는다. */}
      {!heroOverlay ? (
        <div className="mx-auto max-w-5xl px-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
              {EVENT_TYPE_LABELS[event.eventType as keyof typeof EVENT_TYPE_LABELS] ?? String(event.eventType)}
            </span>
            <span className={`rounded-full px-3 py-1 text-sm font-medium ${ageVariant}`}>
              {event.ageRating === "18+" ? "18세 이상" : AGE_RATING_LABELS[event.ageRating as keyof typeof AGE_RATING_LABELS] ?? String(event.ageRating)}
            </span>
          </div>
          <h1 className="mt-3 text-2xl font-black leading-[1.15] tracking-[-0.03em] text-foreground sm:text-3xl lg:text-4xl">
            {heroHeadline || String(event.title)}
          </h1>
          {heroSubtext ? (
            <p className="mt-2 max-w-2xl text-base text-muted-foreground">{heroSubtext}</p>
          ) : null}
        </div>
      ) : null}

      {/* ── 공개 공지 ── */}
      {Array.isArray(event.notices) && event.notices.length > 0 ? (
        <div className="mx-auto max-w-5xl px-4 pt-6">
          <div className="space-y-2">
            {(event.notices as Array<{ id: string; type: string; title: string; content: string; publishedAt: string | null }>).map((notice) => {
              const style =
                notice.type === "cancellation" ? "border-error/40 bg-error/5 text-error" :
                notice.type === "schedule_change" ? "border-warning/40 bg-warning/5 text-warning" :
                notice.type === "refund" ? "border-warning/40 bg-warning/5 text-warning" :
                "border-primary/40 bg-primary/5 text-primary";
              const label =
                notice.type === "cancellation" ? "취소" :
                notice.type === "schedule_change" ? "일정 변경" :
                notice.type === "refund" ? "환불" : "공지";
              return (
                <div key={notice.id} className={`rounded-lg border p-4 ${style}`}>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-current/10 px-2 py-0.5 text-[10px] font-bold uppercase">{label}</span>
                    <span className="text-sm font-bold">{notice.title}</span>
                  </div>
                  {notice.content ? <p className="mt-1 text-sm opacity-80">{notice.content}</p> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ── 갤러리 (선택, 최대 4장) — 클릭 시 전체화면 확대 + 캡션 ── */}
      {galleryViews.length > 0 ? (
        <div className="mx-auto max-w-5xl px-4 pt-8">
          <GalleryLightbox items={galleryViews} />
        </div>
      ) : null}

      {/* ── 메인 컨텐츠 ── */}
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_340px]">

          {/* ── 왼쪽: 이벤트 정보 ── */}
          <div className="space-y-10">

            {/* 카운트다운 (홈페이지 디자이너 토글 연동)
             *
             * 🔴 2026-07-28 "N명 참여 예정" 뱃지 제거. 두 가지가 겹쳐 **틀린 숫자를 팔던 자리**다:
             *   ① 집계가 go `attendees` 를 **상태 구분 없이** COUNT 했다 — 취소·환불·대기까지 포함.
             *      실측: 유효 참석자 0명인데 화면은 "5명 참여 예정".
             *   ② 그 go 테이블은 레벨2 컷오버로 폐기 대상이라 어차피 정본이 아니다.
             * 공개 판매 페이지에서 부풀려진 참여자 수는 소비자 오인 소지가 있어 **고치는 대신 뺀다**.
             * 다시 넣는다면 v2 유효 티켓(active/used) 기준으로 세야 한다.
             */}
            {/* 🔴 래퍼째 조건부로 렌더한다. 종전에는 카운트다운이 꺼져도 **빈 div 가 남아**
                부모의 `space-y-10`(40px)이 그대로 먹혀 왼쪽 열만 아래로 밀렸다
                → 탭 바와 우측 "티켓 선택" 카드의 상단 줄이 어긋났다. */}
            {event.startsAt && hpDesign.showCountdown !== false ? (
              <div className="flex flex-wrap items-center gap-4">
                {/* starts_at(공연 시작) 카운트다운 — '티켓오픈'이 아니라 공연 시작까지임을 라벨로 명시. */}
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-content-subtle">공연 시작까지</span>
                  <CountdownTimer targetDate={String(event.startsAt)} />
                </div>
              </div>
            ) : null}

            {/* 정보 영역 = 탭. 섹션→탭 배치는 event-detail-tabs.tsx 주석 참조. */}
            <EventDetailTabs
              tabs={eventTabs}
              panels={{
                intro: (
                  <>
                {/* 설명 — 🔴 장소 탭과 **같은 카드**를 쓴다 (2026-07-31 대표 지적).
                    종전엔 여기만 카드가 없어, 같은 상세 이미지인데 탭을 옮기면
                    한쪽은 안내 상자 안에·한쪽은 맨몸으로 보였다. */}
                {/* 🔴 「이벤트 소개가 준비 중입니다」를 더 이상 쓰지 않는다 (2026-08-01 대표 지적).
                    판매 중인 행사가 스스로 미완성이라고 광고하는 꼴이었다 — 소개글이 없어도
                    바로 아래 안내 이미지에 내용이 다 들어 있다(글 대신 이미지로 넣은 것).
                    ⚠️ `??` 는 빈 문자열을 못 거른다("" ?? x → ""). 소개글을 **지우면** 저장되는
                       값이 정확히 그것이라, 폴백도 안 타고 빈 문단만 남았다.
                       판정은 `resolveIntroText` 한 곳에서 한다. */}
                {showsIntroSection(introText, introImages.length) ? (
                  <DetailSectionCard>
                    <h2 className="text-2xl font-bold text-foreground">이벤트 안내</h2>
                    {introText ? (
                      /* 🔴 break-words 필수 — 주최자가 넣은 긴 URL·공백 없는 문자열이 컨테이너를
                         밀어내 **가로 스크롤**이 생긴다(모바일에서 특히 잘 터진다).
                         whitespace-pre-line 은 줄바꿈 보존용이고, 그것만으로는 안 막힌다. */
                      <p className="whitespace-pre-line break-words text-base leading-8 text-muted-foreground">
                        {introText}
                      </p>
                    ) : null}
                    {/* 라벨을 비운다 — 바로 위 `이벤트 안내` 와 같은 말이 두 번 나온다. */}
                    <DetailImageBox items={introImages} />
                  </DetailSectionCard>
                ) : null}

                {/* 정보 카드 그리드 */}
                <ScrollReveal>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <CalendarDays className="size-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-xs font-medium text-content-muted">일시</p>
                        <p className="mt-0.5 text-sm font-semibold text-foreground">{formatDate(String(event.startsAt))}</p>
                        {event.endsAt ? (
                          <p className="text-xs text-content-subtle">~ {formatDate(String(event.endsAt))}</p>
                        ) : null}
                        {(event as { runtimeMinutes?: number | null }).runtimeMinutes ? (
                          <p className="mt-1 text-xs text-primary font-medium">
                            공연시간 {(event as { runtimeMinutes: number }).runtimeMinutes}분
                            {(event as { intermissionMinutes?: number | null }).intermissionMinutes
                              ? ` (인터미션 ${(event as { intermissionMinutes: number }).intermissionMinutes}분 포함)`
                              : ""}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <MapPin className="size-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-xs font-medium text-content-muted">장소</p>
                        <p className="mt-0.5 text-sm font-semibold text-foreground">
                          {event.isOnline ? "온라인" : String(event.venueName ?? "장소 미정")}
                        </p>
                      </div>
                    </div>
                    {/* 주최자 표시 (홈페이지 디자이너 토글 연동) */}
                    {hpDesign.showOrganizer !== false && organizerLines.length > 0 ? (
                      <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <Ticket className="size-5 text-primary" />
                        </div>
                        <div>
                          {/* 역할명이 라벨을 대신한다 — 별도 "주최자" 헤더를 두면 중복이다.
                              🔴 **라벨 위 / 값 아래** — 옆 카드(일시·장소)와 같은 구조여야 한다.
                                 가로로 나란히 두면 세 카드의 정렬이 어긋나고, 주관·후원이
                                 추가될 때마다 옆으로 밀려 더 어색해진다(2026-07-30 대표 지적).
                              겸직(협회=주최+주관)은 블록이 아래로 쌓여 자연히 확장된다. */}
                          <dl className="space-y-2">
                            {organizerLines.map((line) => (
                              <div key={line.role}>
                                <dt className="text-xs font-medium text-content-muted">{line.label}</dt>
                                <dd className="mt-0.5 text-sm font-semibold text-foreground">{line.names}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </ScrollReveal>

                  </>
                ),
                venue: (
                  <>
                {/* 장소 지도 (홈페이지 디자이너 토글 연동) */}
                {hpDesign.showVenueMap !== false ? (
                  <ScrollReveal>
                    <VenueMap
                      venueName={event.venueName as string | null}
                      venueAddress={event.venueAddress as string | null}
                      transportInfo={(event as { transportInfo?: string | null }).transportInfo ?? null}
                      parkingInfo={(event as { parkingInfo?: string | null }).parkingInfo ?? null}
                      transportImages={detailImagesFor(detailImages, "transport")}
                      parkingImages={detailImagesFor(detailImages, "parking")}
                    />
                  </ScrollReveal>
                ) : null}

                  </>
                ),
                program: (
                  <>
                {/*
                  🔴 자유문구 렌더 블록 (2026-08-02).
                  이게 **먼저** 있어야 한다 — `event-tabs.ts` 주석이 못박아 둔 순서다:
                  "렌더가 생길 때 조건을 함께 넣는다. 그 반대 순서는 항상 빈 탭을 만든다."
                  종전엔 판정(`hasProgramTab`)만 `programNotes` 를 보고 있고 그릴 곳이
                  없어서, 값이 생기는 순간 **빈 탭**이 될 구조였다.
                  ⚠️ 줄바꿈이 항목 구분이라 `whitespace-pre-line` 필수.
                     `break-words` 는 주최자가 넣은 긴 URL 이 가로 스크롤을 만들지 않게.
                */}
                {introPrograms.programNotes ? (
                  <ScrollReveal>
                    <div className="space-y-3">
                      <h2 className="text-2xl font-bold text-foreground">프로그램 안내</h2>
                      <p className="whitespace-pre-line break-words text-base leading-8 text-muted-foreground">
                        {introPrograms.programNotes}
                      </p>
                    </div>
                  </ScrollReveal>
                ) : null}
                {introPrograms.stageInfo ? (
                  <ScrollReveal>
                    <div className="space-y-3">
                      <h2 className="text-2xl font-bold text-foreground">무대·구역 안내</h2>
                      <p className="whitespace-pre-line break-words text-base leading-8 text-muted-foreground">
                        {introPrograms.stageInfo}
                      </p>
                    </div>
                  </ScrollReveal>
                ) : null}
                {/* 일정 */}
                {Array.isArray((event as { schedules?: Array<{ id: string; title: string; startsAt: string; venueName: string | null; description: string | null; imageUrl?: string | null }> }).schedules) &&
                (event as { schedules?: Array<{ id: string; title: string; startsAt: string; venueName: string | null; description: string | null; imageUrl?: string | null }> }).schedules!.length > 0 ? (
                  <ScrollReveal>
                    <div className="space-y-4">
                      {sectionDescriptions.schedule ? (
                        <p className="text-sm text-muted-foreground">{sectionDescriptions.schedule}</p>
                      ) : null}
                      <div className="flex items-center gap-2">
                        <Clock className="size-5 text-primary" />
                        <h2 className="text-2xl font-bold text-foreground">이벤트 일정</h2>
                      </div>
                      <div className="space-y-3">
                        {(event as { schedules: Array<{ id: string; title: string; startsAt: string; venueName: string | null; description: string | null; imageUrl?: string | null }> }).schedules.map((schedule) => (
                          <div key={schedule.id} className="rounded-xl border border-border bg-card p-5 shadow-xs">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <h3 className="font-semibold text-foreground">{schedule.title}</h3>
                              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{formatDate(schedule.startsAt)}</span>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">{schedule.description ?? "상세 설명이 없습니다."}</p>
                            {schedule.venueName ? <p className="mt-2 text-xs text-content-muted">{schedule.venueName}</p> : null}
                            {schedule.imageUrl ? (
                              /* 🔴 조편성표처럼 **글자가 든 안내물**이 들어온다. `h-auto w-full` 로 폭만 맞추고
                                 비율은 원본대로 둔다 — 높이 고정·object-cover 는 글자를 자른다
                                 (`detail-images.tsx` 가 같은 이유로 그렇게 돼 있다).
                                 폰에서는 카드 여백(p-5)만큼 되돌려 카드 가장자리까지 넓힌다. */
                              <div className="mt-3 max-sm:-mx-5">
                                {/* eslint-disable-next-line @next/next/no-img-element -- 외부/로컬 혼용 URL, next/image remotePatterns 불필요 */}
                                <img
                                  src={schedule.imageUrl}
                                  alt={`${schedule.title} 안내 이미지`}
                                  loading="lazy"
                                  className="h-auto w-full rounded-lg max-sm:rounded-none"
                                />
                                {/* 폰에서 조편성표 글자는 축소되면 못 읽는다 — 원본을 여는 길을 남긴다. */}
                                <a
                                  href={schedule.imageUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="mt-2 inline-block text-xs font-medium text-primary underline underline-offset-4 max-sm:mx-5"
                                >
                                  이미지 크게 보기
                                </a>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  </ScrollReveal>
                ) : null}

                  </>
                ),
                contact: (
                  <>
                {/* 문의·공유 섹션 상세 이미지 — 주최자가 만든 안내물(고객센터 운영시간 등) */}
                <DetailImageBox
                  label={DETAIL_SECTION_LABELS.contact}
                  items={detailImagesFor(detailImages, "contact")}
                />

                {/* 🔴 공유 버튼(카카오·네이버·X·링크복사)은 2026-07-31 에 여기서 제거했다.
                    이 탭은 **문의 창구**이고 앞으로 리뷰 게시판이 들어올 자리다 — 공유 버튼이
                    섞이면 성격이 흐려진다. 공유는 구매완료 페이지에 그대로 남아 있다
                    (거기가 실제로 공유가 일어나는 지점이다). 되살리지 말 것. */}

                {/* 주최자 문의 폼 — POST /api/public/inquiries 소비(통합 문의 원장으로 인입) */}
                <div className="pt-2">
                  <InquiryForm eventSlug={eventSlug} />
                </div>
                  </>
                ),
              }}
            />
          </div>

          {/* ── 오른쪽: 티켓 + CTA (sticky) ── */}
          <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">

            {(event as { rsvpEnabled?: boolean }).rsvpEnabled ? (
              // RSVP(무료 참석) 이벤트 — 티켓 판매 대신 참석 등록만 노출 (rsvp_enabled 배타)
              <RsvpForm eventId={String(event.id)} />
            ) : (
              <>
            {/* 티켓 상품 카드 */}
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-md">
              <div className="border-b border-border bg-bg-muted px-5 py-4">
                <h2 className="font-bold text-foreground">티켓 선택</h2>
                {sectionDescriptions.products ? (
                  <p className="mt-1 text-xs text-content-subtle">{sectionDescriptions.products}</p>
                ) : null}
              </div>
              <div className="divide-y divide-border">
                {event.products.map((product: {
                  id: string;
                  name: string;
                  description: string | null;
                  price: number | string;
                  /** 정가(할인 전). 없으면 취소선을 그리지 않는다 — `face-price.ts`. */
                  facePrice?: number | null;
                  stock: number | null;
                  taxIncluded?: boolean;
                  isOnSale?: boolean;
                }) => {
                  const soldOut = product.stock === 0;
                  const lowStock = product.stock !== null && product.stock > 0 && product.stock < 20;
                  return (
                    <div key={String(product.id)} className={`p-5 ${soldOut ? "opacity-50" : ""}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-foreground">{String(product.name)}</h3>
                            {soldOut ? (
                              <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">매진</span>
                            ) : lowStock ? (
                              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">잔여 {product.stock}장</span>
                            ) : null}
                          </div>
                          {product.description ? (
                            <p className="mt-1.5 text-sm text-muted-foreground">{String(product.description)}</p>
                          ) : null}
                          {product.isOnSale === false ? (
                            <p className="mt-1.5 text-xs text-warning">판매 기간이 아닙니다</p>
                          ) : null}
                        </div>
                        {/*
                          정가가 판매가보다 **높을 때만** 취소선을 그린다(`face-price.ts`).
                          정가 미시딩·동일가 행사에서는 아무것도 그리지 않는다 — `~~₩0~~` 방지.
                        */}
                        <div className="shrink-0 text-right">
                          {(() => {
                            const face = strikethroughPrice(product.price, product.facePrice);
                            return face === null ? null : (
                              <p data-testid="face-price" className="text-sm font-semibold text-content-muted line-through">
                                {formatKRW(face)}
                              </p>
                            );
                          })()}
                          <p className="text-lg font-black text-foreground">
                            {Number(product.price ?? 0) === 0 ? "무료" : formatKRW(Number(product.price ?? 0))}
                          </p>
                        </div>
                      </div>
                      {product.taxIncluded ? <p className="mt-1 text-right text-xs text-content-muted">(세금 포함)</p> : null}
                    </div>
                  );
                })}
              </div>
            </div>

            <QueuePurchaseGate
              eventId={String(event.id)}
              eventSlug={eventSlug}
              queueEnabled={event.queueEnabled === true}
              soldOut={isSoldOut}
              label={ctaText || "티켓 구매하기"}
            />

            {/* 트러스트 뱃지 — CTA 바로 아래 */}
            <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-content-subtle">
              <span className="flex items-center gap-1">
                <Shield className="size-3.5 text-primary" />
                안전 결제
              </span>
              <span className="flex items-center gap-1">
                <RefreshCcw className="size-3.5 text-primary" />
                환불 보장
              </span>
              <span className="flex items-center gap-1">
                <Smartphone className="size-3.5 text-primary" />
                즉시 발급
              </span>
            </div>

            {/* 환불 정책 */}
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-sm font-semibold text-foreground">환불 정책</p>
              {/* 🔴 하드코딩 금지 (2026-07-31 실사고). 종전엔 D-10 100%/D-7 90%/D-3 80% 가
                  박혀 있었는데 DB 실값은 D-7 70%/D-3 50% 였다 — **구매자가 80% 라고 보고
                  50% 를 받았다.** 표시와 지급이 갈리면 분쟁이 된다. DB 만 보고 그린다. */}
              {refundPolicyLines.length > 0 ? (
                <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                  {refundPolicyLines.map((line) => (
                    <div key={line.label} className="flex items-center gap-2">
                      <span
                        className={`size-1.5 rounded-full ${
                          line.tone === "success" ? "bg-success" : line.tone === "danger" ? "bg-error" : "bg-warning"
                        }`}
                      />
                      {line.label}{" "}
                      {/* 🔴 "무엇의 %인지" 를 반드시 붙인다 — 숫자만 있으면 수수료율로
                          정반대로 읽힌다(2026-08-01 감사 P1-⑤). */}
                      <span className="font-semibold text-foreground">{line.refundLabel}</span>
                    </div>
                  ))}
                  <p className="pt-1 text-[11px] text-muted-foreground">
                    결제 금액 기준 환불률입니다. 기준 시각은 행사일 00시(KST)입니다.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">환불 규정이 설정되지 않았습니다.</p>
              )}
              {/* 🔴 주최자 자유 문구 — **새 저장 필드를 만들지 않았다** (2026-07-31 판단).
                  `open_notices` 에 `type: "refund"` 자유문구가 **이미 있었고** 페이지 상단
                  공지 목록에 렌더되고 있었다. 새 필드를 파면 같은 내용을 두 곳에서
                  관리하게 되고, 둘이 어긋나는 순간 어느 쪽이 약속인지 알 수 없어진다.
                  ⟹ 저장은 그대로 두고 **여기서도 함께 보여준다**(단계 숫자만으로는
                  "천재지변 시 별도" 같은 조건을 표현할 수 없다). */}
              {refundNotice ? (
                <p className="mt-3 whitespace-pre-line border-t border-border pt-3 text-xs text-muted-foreground">
                  {refundNotice}
                </p>
              ) : null}
              <Link href="/refund-policy" className="mt-3 inline-block text-xs text-primary hover:underline">
                상세보기 →
              </Link>
            </div>

              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Sticky CTA (모바일) ── */}
      <StickyCTABar
        eventId={String(event.id)}
        eventSlug={eventSlug}
        queueEnabled={event.queueEnabled === true}
        minPrice={minPrice}
        maxPrice={maxPrice}
        isSoldOut={isSoldOut}
      />
      {/*
        🔴 챗봇 위젯을 **내렸다** (2026-08-03, 대표 지시 — 지금은 안 쓴다).
           렌더만 뺐고 컴포넌트·API 라우트는 남긴다. 다시 켤 때 아래 한 줄만 살리면 된다.
      
        ⚠️ 내릴 당시 prod 에서 **이미 502 로 죽어 있었다**:
           `/api/public/chat` 은 v2 `POST /api/v1/chat` 프록시인데 502 가 돌아왔다.
           손님이 눌러도 "응답 생성에 실패했습니다" 만 봤다는 뜻이다.
      
        ⚠️ **문의는 그대로다** — 「문의」 탭의 InquiryForm(`/api/public/inquiries`)은
           별개 경로이고 살아 있다. 챗봇만 사라진다.
      */}
      {/* <EventChatbot eventId={String(event.id)} eventSlug={eventSlug} /> */}
    </div>
  );
}
import { toRefundPolicyLines } from "@/lib/refund/policy-display";

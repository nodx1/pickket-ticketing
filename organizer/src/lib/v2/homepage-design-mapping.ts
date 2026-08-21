/**
 * 트랙B U2 — go homepage_design(JSON) → v2 event_pages 매핑.
 *
 * 갭: 주최자가 organizer homepage-designer 에서 만든 랜딩(events.homepage_design)이 v2 로
 * write-through 되지 않아 소비자 화이트라벨 /s/{subdomain} 에 커스텀 랜딩이 반영 안 됐다.
 * 이 모듈이 go JSON → v2 event_pages 페이로드(page_theme 색토큰 + page_data Puck)로 변환한다.
 *
 * ── 매핑표(필드별) ──────────────────────────────────────────────────────────
 * go homepage_design          → v2 event_pages
 * ─────────────────────────────────────────────────────────────────────────────
 * backgroundColor (hex)       → page_theme.bg
 * textColor (hex)             → page_theme.text
 * accentColor (hex)           → page_theme.accent  (+ accentGlow 파생 없음)
 * heroHeadline                → page_data(Puck) HeroBanner.title
 * heroSubtext                 → page_data(Puck) HeroBanner.subtitle
 * ctaText                     → page_data(Puck) HeroBanner.ctaText
 * coverImageUrl               → page_data(Puck) HeroBanner.imageUrl  (+ meta 보존)
 *
 * heroFit (cover/contain)     → ✅소비: page_data(Puck) HeroBanner.fit (+ meta 보존).
 *                                 소비자 puck-render-config HeroBanner 가 fit 을 소비하도록 확장 필요(frontend 후속).
 *                                 현 렌더는 center/cover 하드코딩 → fit prop 은 전달되나 렌더가 무시(무해).
 * showCountdown (bool)        → ✅소비: true 이면 page_data(Puck) content 에 CountdownBlock 블록 append.
 *                                 소비자 puck-render-config CountdownBlock 이 이미 존재 → 즉시 렌더 가능.
 *
 * ── 손실/부분매핑(§D2, v2 구조에 대응 필드 없음 → white_label_config.homepage_design_meta 로 원본 보존) ──
 * templateId (minimal/bold/…) → ⚠️손실: go=시각 테마 프리셋, v2 page_template=레이아웃(concert/…) 개념이 달라
 *                                 page_template 에 매핑 불가. 원본만 meta 보존. TODO: 색 프리셋→page_theme 확장 매핑.
 * sections (event/products/…) → ⚠️손실: v2 sections 는 다른 타입 집합(hero/text/gallery/lineup/…). 원본만 meta 보존.
 *                                 TODO(규모 큼): go sections 순서·집합을 Puck content 블록 배열로 재구조화.
 * showVenueMap/showOrganizer  → ⚠️손실: 대응 Puck 블록 없음(장소지도·주최자 카드). meta 보존.
 *                                 TODO: 소비자 puck-render-config 에 VenueMap/OrganizerCard 블록 추가 후 소비.
 * sectionDescriptions         → ⚠️손실: 섹션 카피. meta 보존. TODO: Puck TextBlock 블록화(섹션별 append) 검토.
 * aiGenerated                 → meta 보존(감사용).
 * refundNotice                → ⚠️손실: 환불 안내 자유문구(2026-07-31 신설). meta 보존.
 *                                 🔴 **소비자 화이트라벨 랜딩(/s/{subdomain})에는 안 나온다.**
 *                                 go 공개 상세(go.pickket.kr/e/…)의 환불 카드에만 표시된다.
 *                                 같은 행사를 두 채널로 팔면 **환불 고지가 채널마다 달라진다** —
 *                                 환불 분쟁에서 정확히 문제되는 형태다.
 *                                 KLPGA 는 go 단일 판매라 지금은 무해하나, 소비자 채널을 열기
 *                                 전에 반드시 매핑할 것(Puck TextBlock 또는 전용 블록).
 *
 * ⚠️ coverImageUrl vs event.image_url: 소비자 기본(non-Puck) 랜딩은 event.image_url(EventWriteInput 로 별도
 *    sync)로 히어로를 렌더한다. 여기서는 커스텀 Puck 히어로에만 coverImageUrl 을 넣는다(둘은 별개 경로).
 */
import type { EventPageUpsertInput } from "@/lib/v2/commerce-client";

/** go homepage_design JSON(homepage-design/route.ts PUT schema 와 동형). 전부 optional 방어. */
export interface HomepageDesign {
  coverImageUrl?: string;
  backgroundColor?: string;
  textColor?: string;
  accentColor?: string;
  showCountdown?: boolean;
  showVenueMap?: boolean;
  showOrganizer?: boolean;
  sections?: string[];
  templateId?: string;
  heroHeadline?: string;
  heroSubtext?: string;
  heroFit?: "cover" | "contain";
  ctaText?: string;
  sectionDescriptions?: Record<string, string>;
  aiGenerated?: boolean;
  /**
   * 소개 본문 아래 상세 안내 이미지.
   *
   * ⚠️ 소비자 화이트라벨 랜딩(`/s/{subdomain}`)은 **아직 이 값을 렌더하지 않는다** —
   *    현재 노출 경로는 go 네이티브 공개 페이지(`/e/{slug}`) 뿐이다.
   *    그래도 meta 에 실어 보내는 이유는, 나중에 소비자 쪽이 이 값을 쓰기 시작할 때
   *    주최자가 **다시 저장하지 않아도** 되게 하기 위해서다(다른 손실 필드와 같은 처리).
   */
  detailImages?: Array<{ url: string; caption?: string }>;
}

/** #RRGGBB HEX 만 통과(v2 page_theme color 검증과 정합). 그 외는 drop. */
function safeHex(v: string | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
}

/** homepage_design 의 색토큰 → v2 page_theme(camelCase). 정의된 색만 포함(부분 patch·병합). */
function toPageTheme(design: HomepageDesign): Record<string, string> | null {
  const theme: Record<string, string> = {};
  const bg = safeHex(design.backgroundColor);
  const text = safeHex(design.textColor);
  const accent = safeHex(design.accentColor);
  if (bg) theme.bg = bg;
  if (text) theme.text = text;
  if (accent) theme.accent = accent;
  return Object.keys(theme).length > 0 ? theme : null;
}

/**
 * 히어로 카피/커버(또는 소비 가능한 토글)가 있으면 Puck page_data(content 블록 배열) 구성.
 * 소비자 SubdomainLandingClient 는 page_data.content.length>0 이면 PuckRenderer 로 커스텀 렌더한다.
 * 블록이 하나도 안 나오면 null(=기본 ImmersiveHero 랜딩 유지, 불필요한 빈 Puck 미생성).
 *
 * 소비 가능해진 것(F7):
 *  - heroFit → HeroBanner.fit prop (소비자 렌더 확장 대기, 전달은 무해)
 *  - showCountdown=true → CountdownBlock append (소비자 렌더 이미 존재 → 즉시 렌더)
 */
function toPageData(design: HomepageDesign): Record<string, unknown> | null {
  const title = design.heroHeadline?.trim();
  const subtitle = design.heroSubtext?.trim();
  const ctaText = design.ctaText?.trim();
  const imageUrl = design.coverImageUrl?.trim();
  const fit = design.heroFit === "contain" || design.heroFit === "cover" ? design.heroFit : undefined;
  const showCountdown = design.showCountdown === true;

  const content: Array<Record<string, unknown>> = [];

  // HeroBanner: 카피/커버 또는 fit 중 하나라도 있으면 생성.
  if (title || subtitle || ctaText || imageUrl || fit) {
    const heroProps: Record<string, unknown> = {};
    if (title) heroProps.title = title;
    if (subtitle) heroProps.subtitle = subtitle;
    if (ctaText) heroProps.ctaText = ctaText;
    if (imageUrl) heroProps.imageUrl = imageUrl;
    // fit: 소비자 HeroBanner 가 배경 objectFit(cover/contain) 을 소비하도록 확장 예정(frontend 후속).
    if (fit) heroProps.fit = fit;
    content.push({ type: "HeroBanner", props: { id: "hero-1", ...heroProps } });
  }

  // CountdownBlock: showCountdown=true 이면 append. label 은 소비자 렌더 기본 카피 사용 가능.
  if (showCountdown) {
    content.push({ type: "CountdownBlock", props: { id: "countdown-1", label: "공연까지" } });
  }

  if (content.length === 0) return null;

  return {
    // Puck 데이터 계약: content(블록 배열) + root. 소비자 puck-render-config 블록들과 props 정합.
    content,
    root: { props: {} },
  };
}

/** 손실/미매핑 필드 원본 보존(감사·향후 소비자 확장 대비). white_label_config 에 격리 저장. */
function toMeta(design: HomepageDesign): Record<string, unknown> {
  return {
    homepage_design_meta: {
      template_id: design.templateId ?? null,
      sections: design.sections ?? null,
      show_countdown: design.showCountdown ?? null,
      show_venue_map: design.showVenueMap ?? null,
      show_organizer: design.showOrganizer ?? null,
      section_descriptions: design.sectionDescriptions ?? null,
      hero_fit: design.heroFit ?? null,
      cover_image_url: design.coverImageUrl ?? null,
      ai_generated: design.aiGenerated ?? null,
      // 소비자 랜딩이 아직 렌더하지 않는 값 — 그래도 보존해 재저장 없이 쓸 수 있게 한다.
      detail_images: design.detailImages ?? null,
    },
  };
}

/**
 * go homepage_design → v2 event_pages upsert 페이로드.
 * page_published=true 고정: go 랜딩 저장 = 게시. 실 공개 게이트는 이벤트 status(v2 SoT) 이며
 * event_pages.py by-subdomain 은 published 페이지만 노출하므로, 저장분이 소비자에 반영되려면 published 필수.
 * subdomain_slug 는 미전송(v2 최초 생성 시 event.slug 자동 파생, 재호출 시 기존 URL 유지).
 */
export function mapHomepageDesignToEventPage(design: HomepageDesign): EventPageUpsertInput {
  return {
    page_theme: toPageTheme(design),
    page_data: toPageData(design),
    white_label_config: toMeta(design),
    page_published: true,
  };
}

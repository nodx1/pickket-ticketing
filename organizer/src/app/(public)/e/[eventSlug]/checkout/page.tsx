import type { Metadata } from "next";
import { eventPagePath } from "@/lib/public/event-path";
import { notFound } from "next/navigation";
import { getEvent, listPromoCodes } from "@/lib/v2/commerce-client";
import {
  shouldShowPromoInput,
  type PromoAvailabilityRow,
} from "@/lib/checkout/promo-availability";
import { logger } from "@/lib/logger";
import { normalizeEventSlug } from "@/lib/public/event-slug";
import { getPublicEventBySlug, CheckoutPricingError } from "@/lib/server/events";
import { CheckoutTicketStep } from "./_components/checkout-ticket-step";
import { CheckoutPricingUnavailable } from "./_components/checkout-pricing-unavailable";


/**
 * 🔴 결제 화면의 브라우저 제목 (2026-08-01 감사 P1-②).
 *
 * 종전엔 루트 기본값이 그대로 나와 **"PICKKET.GO — 이벤트를 여는 모든 사람을 위해"**
 * 였다. 탭을 여러 개 열어두고 결제하는 사람이 **어느 탭이 결제창인지 못 찾는다.**
 * 단계가 보이게 한다.
 *
 * ⚠️ 평문 문자열을 주면 루트 `title.template` 이 브랜드를 붙인다 — 여기서 브랜드를
 *    또 쓰면 `— PICKKET.GO — PICKKET.GO` 가 된다(`lib/seo/site.ts` 참조).
 * ⚠️ 구매 절차 화면은 색인 대상이 아니다.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ eventSlug: string }>;
}): Promise<Metadata> {
  const { eventSlug } = await params;
  return {
    title: `1단계 · 티켓 선택`,
    description: "티켓 선택 단계입니다.",
    robots: { index: false, follow: false },
    alternates: { canonical: eventPagePath(normalizeEventSlug(eventSlug)) ?? undefined },
  };
}

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ eventSlug: string }>;
}) {
  // 한글 slug 이벤트가 404 로 죽던 결함 — normalizeEventSlug 주석 참조.
  const { eventSlug: rawSlug } = await params;
  const eventSlug = normalizeEventSlug(rawSlug);

  // authoritativePricing=true: 표시/선택 금액을 v2 tier 정본으로 공급(서버 initiate 와 일치).
  // v2 미앵커·티어 매칭 실패·v2 read 실패 시 CheckoutPricingError → 안내 화면으로 명시적 중단.
  let event: Awaited<ReturnType<typeof getPublicEventBySlug>>;
  try {
    event = await getPublicEventBySlug(eventSlug, { authoritativePricing: true });
  } catch (err: unknown) {
    if (err instanceof CheckoutPricingError) {
      return <CheckoutPricingUnavailable message={err.message} />;
    }
    throw err;
  }

  if (!event) {
    notFound();
  }

  // 🔴 T13: 카드사 자동할인 안내용. `getPublicEventBySlug`(server/events.ts)를 건드리지 않고
  //    여기서 따로 읽는다 — 그 파일은 다른 세션 소유이고 뮤테이션으로 고정된 회귀가 붙어 있다.
  //    ⚠️ **표시 전용**이라 실패해도 체크아웃을 막지 않는다(안내가 안 뜰 뿐).
  //       실제 할인 적용은 결제수단 선택 단계에서 서버가 한다.
  let cardDiscounts: Record<string, { rate: number }> | null = null;
  try {
    const detail = await getEvent(event.id);
    // 🔴 `discount_code` 를 **반드시 벗겨서** 넘긴다. internal 응답에는 실려 오지만
    //    브라우저가 알면 임의 적용을 시도할 수 있다 — 적용 주체는 서버여야 한다.
    cardDiscounts = detail.card_discounts
      ? Object.fromEntries(
          Object.entries(detail.card_discounts).map(([card, cfg]) => [card, { rate: cfg.rate }]),
        )
      : null;
  } catch (err: unknown) {
    logger.warn("카드사 할인 안내 조회 실패(안내 생략)", {
      eventId: event.id,
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  // 🔴 프로모코드 입력칸 노출 판정 — 종전엔 카드사 할인이 없으면 **무조건** 보여줬다.
  //    코드를 하나도 안 만든 주최자의 구매자도 입력칸을 보고, 뭘 넣든 "유효하지 않은
  //    프로모코드입니다" 가 돌아온다(막다른 길). prod KLPGA 가 그 상태였다.
  //    ⚠️ **조회 실패 시 `null` → 보여준다**(fail-open). 숨기면 유효한 코드를 든 구매자가
  //       쓸 방법이 없어진다 — 금전 경로라 모를 때 막는 쪽이 더 나쁘다.
  //    cardDiscounts 와 같은 "표시 전용 부가조회" 선례를 따른다(실패해도 체크아웃 불가 아님).
  let promoRows: PromoAvailabilityRow[] | null = null;
  try {
    const { promo_codes } = await listPromoCodes(event.id);
    promoRows = promo_codes;
  } catch (err: unknown) {
    logger.warn("프로모코드 노출 판정 조회 실패(입력칸 유지)", {
      eventId: event.id,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
  const showPromoInput = shouldShowPromoInput(promoRows, new Date());

  return <CheckoutTicketStep event={{ ...event, cardDiscounts, showPromoInput }} />;
}

import type { Metadata } from "next";
import { eventPagePath } from "@/lib/public/event-path";
import { notFound } from "next/navigation";
import { getEvent } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";
import { normalizeEventSlug } from "@/lib/public/event-slug";
import { getPublicEventBySlug } from "@/lib/server/events";
import { CheckoutPaymentStep } from "./_components/checkout-payment-step";


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
    title: `3단계 · 결제`,
    description: "결제 단계입니다.",
    robots: { index: false, follow: false },
    alternates: { canonical: eventPagePath(normalizeEventSlug(eventSlug)) ?? undefined },
  };
}

export default async function CheckoutPaymentPage({
  params,
}: {
  params: Promise<{ eventSlug: string }>;
}) {
  // 한글 slug 이벤트가 404 로 죽던 결함 — normalizeEventSlug 주석 참조.
  const { eventSlug: rawSlug } = await params;
  const eventSlug = normalizeEventSlug(rawSlug);
  const event = await getPublicEventBySlug(eventSlug, { includeSeats: false });

  if (!event) {
    notFound();
  }

  // 🔴 v2 이벤트 상세를 **직접** 읽는다. 예전엔 `getPublicEventBySlug()` 결과에서
  //    `(event as { allowed_pay_methods?: unknown })` 캐스트로 꺼내려 했는데,
  //    그 함수가 거치는 `toGoEventView`(lib/v2/event-view.ts)는 **명시적 화이트리스트
  //    매퍼**라 두 필드를 복사하지 않는다 → 값이 **항상 undefined** 였다.
  //    캐스트가 tsc 를 침묵시켜 "타입 0건" 인 채로 기능이 죽어 있었다(감사에서 발견).
  //    ⚠️ 이 결함은 `allowed_pay_methods`(나이스 카드전용 게이팅 C2)에도 있었다 — 같이 살린다.
  //    ⚠️ **표시 전용**이라 실패해도 결제를 막지 않는다(안내·게이팅이 안 걸릴 뿐).
  let allowedPayMethods: string[] | null = null;
  let cardDiscounts: Record<string, { rate: number }> | null = null;
  try {
    const detail = await getEvent(String(event.id));
    allowedPayMethods = Array.isArray(detail.allowed_pay_methods)
      ? detail.allowed_pay_methods.filter((v): v is string => typeof v === "string")
      : null;
    // 🔴 `discount_code` 는 internal 응답에만 있다 — 브라우저로 넘기기 전에 **반드시 벗긴다**.
    cardDiscounts = detail.card_discounts
      ? Object.fromEntries(
          Object.entries(detail.card_discounts)
            .filter(([, cfg]) => Number(cfg?.rate) > 0)
            .map(([card, cfg]) => [card, { rate: Number(cfg.rate) }]),
        )
      : null;
  } catch (err: unknown) {
    logger.warn("결제 스텝 이벤트 상세 조회 실패(게이팅·할인 안내 생략)", {
      eventId: String(event.id),
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  return (
    <CheckoutPaymentStep
      eventSlug={eventSlug}
      eventId={String(event.id)}
      eventTitle={String(event.title)}
      allowedPayMethods={allowedPayMethods}
      cardDiscounts={cardDiscounts}
    />
  );
}

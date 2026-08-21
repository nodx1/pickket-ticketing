import type { Metadata } from "next";
import { eventPagePath } from "@/lib/public/event-path";
import { notFound } from "next/navigation";
import { normalizeEventSlug } from "@/lib/public/event-slug";
import { getPublicEventBySlug } from "@/lib/server/events";
import { CheckoutDetailsStep } from "./_components/checkout-details-step";


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
    title: `2단계 · 정보 입력`,
    description: "정보 입력 단계입니다.",
    robots: { index: false, follow: false },
    alternates: { canonical: eventPagePath(normalizeEventSlug(eventSlug)) ?? undefined },
  };
}

export default async function CheckoutDetailsPage({
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

  return (
    <CheckoutDetailsStep
      eventSlug={eventSlug}
      eventId={String(event.id)}
      eventTitle={String(event.title)}
      ageRating={String((event as { ageRating?: string }).ageRating ?? "all")}
      questions={event.questions as Array<{
        id: string;
        label: string;
        questionType: "short_text" | "long_text" | "single_choice" | "multiple_choice" | "checkbox";
        isRequired: boolean;
        options: string[];
      }>}
    />
  );
}

import { GuestOrderClient } from "./_components/GuestOrderClient";

/**
 * 게스트(비회원) 주문 조회 페이지 — /[locale]/guests/orders/[id]?token=...
 *
 * 진입 경로:
 *   1) 주문 직후 GuestCheckoutModal 이 push (token 은 sessionStorage 에 보관됨 → 쿼리 불필요)
 *   2) 이메일 매직링크 재방문 (?token=<view_token> 쿼리로 진입)
 *
 * view_token 우선순위: URL ?token= > sessionStorage. PII 는 서버가 마스킹해 내려준다.
 */
export default async function GuestOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale, id } = await params;
  const { token } = await searchParams;
  return <GuestOrderClient locale={locale} orderId={id} urlToken={token ?? null} />;
}

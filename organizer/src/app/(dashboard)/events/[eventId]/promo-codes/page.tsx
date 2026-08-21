import { PromoCodesClient } from "./_components/promo-codes-client";

export default async function PromoCodesPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <PromoCodesClient eventId={eventId} />;
}

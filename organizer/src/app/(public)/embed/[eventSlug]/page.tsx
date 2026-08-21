import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getPublicEventBySlug } from "@/lib/server/events";
import { formatKRW } from "@/lib/format";

export default async function EmbedEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { eventSlug } = await params;
  const resolvedSearchParams = await searchParams;
  const source = typeof resolvedSearchParams.source === "string" ? resolvedSearchParams.source : "direct";
  const event = await getPublicEventBySlug(eventSlug, { includeSeats: false });
  if (!event) notFound();

  const checkoutUrl = `/e/${eventSlug}/checkout${source ? `?source=${encodeURIComponent(source)}` : ""}`;

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="space-y-4 rounded-lg border border-border bg-card/95 p-5">
        <h1 className="text-2xl font-black tracking-[-0.04em] text-foreground">{String(event.title)}</h1>
        {event.products.map((product: {
          id: string;
          name: string;
          description: string | null;
          price: number | string;
        }) => (
          <div key={String(product.id)} className="flex items-center justify-between rounded-lg border border-border bg-muted px-4 py-3">
            <div>
              <p className="font-medium text-foreground">{String(product.name)}</p>
              <p className="text-sm text-muted-foreground">{String(product.description ?? "")}</p>
            </div>
            <p className="text-foreground">{formatKRW(Number(product.price ?? 0))}</p>
          </div>
        ))}
        <Button asChild className="w-full">
          <Link href={checkoutUrl} target="_blank">구매하기</Link>
        </Button>
      </div>
    </div>
  );
}

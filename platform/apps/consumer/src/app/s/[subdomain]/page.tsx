/**
 * Subdomain event landing page.
 * URL: {slug}.pickket.kr → /s/{slug}/page.tsx
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SubdomainHeader } from "./_components/SubdomainHeader";
import { SubdomainLandingClient } from "./_components/SubdomainLandingClient";
import { getEvent } from "./_lib/get-event";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}): Promise<Metadata> {
  const { subdomain } = await params;
  const event = await getEvent(subdomain);
  if (!event) return {};
  return { title: `${event.title} | Pickket` };
}

export default async function SubdomainEventPage({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const event = await getEvent(subdomain);

  if (!event) {
    notFound();
  }

  return (
    <>
      <SubdomainHeader
        title={event.title}
        logoUrl={event.page_theme?.logoUrl}
      />
      <SubdomainLandingClient event={event} />
    </>
  );
}

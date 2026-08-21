/**
 * Subdomain tickets/booking page.
 * URL: {slug}.pickket.kr/tickets
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SubdomainHeader } from "../_components/SubdomainHeader";
import { SubdomainTicketsClient } from "../_components/SubdomainTicketsClient";
import { getEvent } from "../_lib/get-event";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}): Promise<Metadata> {
  const { subdomain } = await params;
  const event = await getEvent(subdomain);
  if (!event) return {};
  const t = await getTranslations("ticket.ticketsPage");
  return { title: t("metaTitle", { title: event.title ?? "" }) };
}

export default async function SubdomainTicketsPage({
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
      <SubdomainTicketsClient event={event} />
    </>
  );
}

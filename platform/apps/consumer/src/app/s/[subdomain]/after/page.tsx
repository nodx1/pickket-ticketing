/**
 * Subdomain post-event archive page.
 * URL: {slug}.pickket.kr/after
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SubdomainHeader } from "../_components/SubdomainHeader";
import { SubdomainArchiveClient } from "../_components/SubdomainArchiveClient";
import { getEvent } from "../_lib/get-event";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}): Promise<Metadata> {
  const { subdomain } = await params;
  const t = await getTranslations("event.archive");
  const event = await getEvent(subdomain);
  if (!event) return {};
  return { title: t("metaTitle", { title: event.title ?? "" }) };
}

export default async function SubdomainArchivePage({
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
      <SubdomainArchiveClient event={event} />
    </>
  );
}

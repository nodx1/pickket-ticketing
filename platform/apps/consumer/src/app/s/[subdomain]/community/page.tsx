/**
 * Subdomain community page.
 * URL: {slug}.pickket.kr/community
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SubdomainHeader } from "../_components/SubdomainHeader";
import { SubdomainCommunityClient } from "../_components/SubdomainCommunityClient";
import { getEvent } from "../_lib/get-event";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}): Promise<Metadata> {
  const { subdomain } = await params;
  const event = await getEvent(subdomain);
  if (!event) return {};
  const t = await getTranslations("community");
  return { title: t("pageTitle", { title: event.title ?? "" }) };
}

export default async function SubdomainCommunityPage({
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
      <SubdomainCommunityClient event={event} />
    </>
  );
}

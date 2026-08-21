/**
 * Public bridge page — renders an organizer's curated event collection.
 * URL: /bridge/{slug}
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { API_URL } from "@pickket/lib";
import { BridgePageClient } from "./BridgePageClient";

async function getBridgePage(slug: string) {
  try {
    const res = await fetch(`${API_URL}/api/v1/bridge-pages/public/${slug}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const bridgePage = await getBridgePage(slug);
  if (!bridgePage) return { title: "Not Found | Pickket" };

  const title = `${bridgePage.title} | Pickket`;
  const description = bridgePage.content
    ? bridgePage.content.slice(0, 160)
    : `${bridgePage.title} - Pickket 이벤트 모음`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
    },
  };
}

export default async function BridgePageRoute({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { slug } = await params;
  const bridgePage = await getBridgePage(slug);

  if (!bridgePage) {
    notFound();
  }

  return <BridgePageClient bridgePage={bridgePage} />;
}

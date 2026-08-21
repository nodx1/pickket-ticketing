/**
 * Digital photocard share page.
 * URL: {slug}.pickket.kr/photocard/{share_code}
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { API_URL } from "@pickket/lib";
import { PhotocardView } from "../../_components/PhotocardView";

async function getPhotocard(code: string) {
  try {
    const res = await fetch(`${API_URL}/api/v1/photocards/by-code/${code}`, {
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
  params: Promise<{ subdomain: string; code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  const photocard = await getPhotocard(code);
  if (!photocard) return { title: "Not Found | Pickket" };

  const title = `${photocard.event_title} 포토카드 | Pickket`;
  const description = `${photocard.user_name}님의 ${photocard.event_title} 디지털 포토카드`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: photocard.template_url ? [{ url: photocard.template_url }] : [],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: photocard.template_url ? [photocard.template_url] : [],
    },
  };
}

export default async function PhotocardPage({
  params,
}: {
  params: Promise<{ subdomain: string; code: string }>;
}) {
  const { code } = await params;
  const photocard = await getPhotocard(code);

  if (!photocard) {
    notFound();
  }

  return <PhotocardView photocard={photocard} />;
}

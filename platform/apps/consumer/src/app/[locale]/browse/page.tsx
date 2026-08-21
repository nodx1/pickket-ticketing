import { redirect } from "next/navigation";

/**
 * /browse → /events with params forwarded.
 * The /events page has full browsing with category filters, search, sorting, etc.
 */
export default async function BrowsePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // 로케일 보존 — 과거 `/events`(로케일 없음)로 리다이렉트해 /en/browse 가 기본(ko)로 떨어졌다.
  const { locale } = await params;
  const sp = new URLSearchParams();

  for (const [key, value] of Object.entries(await searchParams)) {
    if (value !== undefined) {
      const v = Array.isArray(value) ? value[0] : value;
      if (v) sp.set(key, v);
    }
  }

  const qs = sp.toString();
  redirect(qs ? `/${locale}/events?${qs}` : `/${locale}/events`);
}

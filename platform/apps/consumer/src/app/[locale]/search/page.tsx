import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "검색 | Pickket",
  description: "콘서트, 스포츠, 뮤지컬, 전시 등 원하는 이벤트를 검색하세요",
  robots: { index: false },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sp = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      const v = Array.isArray(value) ? value[0] : value;
      if (v) sp.set(key, v);
    }
  }

  const qs = sp.toString();
  redirect(qs ? `/events?${qs}` : "/events");
}

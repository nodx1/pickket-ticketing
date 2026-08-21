import { redirect } from "next/navigation";

// packages 페이지 삭제 (Phase2 슬림화): products "번들" 필터로 흡수.
// 구 경로 보존을 위해 /products?type=bundle 로 영구 리다이렉트한다.
export default async function PackagesRedirectPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  redirect(`/events/${eventId}/products?type=bundle`);
}

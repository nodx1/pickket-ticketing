import { redirect } from "next/navigation";

// feature-manager 페이지 단일화 (Phase2 슬림화): settings의 FeatureToggles와 중복이라 제거.
// 구 경로 보존을 위해 /settings 로 영구 리다이렉트한다.
export default async function FeatureManagerRedirectPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  redirect(`/events/${eventId}/settings`);
}

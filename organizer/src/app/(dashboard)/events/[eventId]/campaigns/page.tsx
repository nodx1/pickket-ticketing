import { redirect } from "next/navigation";

/**
 * 이메일 캠페인 → 메시지 통합(계획서 §3-3 4단계 리다이렉트).
 *
 * event_messages 가 캠페인의 상위호환(3채널·세그먼트·예약·재발송)이며 SoT 로 흡수됐다.
 * 캠페인 = messages 의 "이메일 채널 + 목적=promotion" 모드. 신규 캠페인 작성은 메시지 작성기에서 수행한다.
 * 파괴적 폐기는 아니며(데이터·라우트 보존), 진입점만 메시지로 수렴시킨다.
 */
export default async function CampaignsPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  redirect(`/events/${eventId}/messages`);
}

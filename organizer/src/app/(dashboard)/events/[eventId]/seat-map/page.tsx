import { redirect } from "next/navigation";

// 좌석 배치도 편집기는 `티켓 & 좌석`(/tickets)에 통합됨. 단독 URL 직접 진입은 이중 경로·맥락 상실을
// 유발하므로 통합 화면으로 리다이렉트한다. (편집기 컴포넌트는 tickets 가 재사용)
export default async function SeatMapPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  redirect(`/events/${eventId}/tickets`);
}

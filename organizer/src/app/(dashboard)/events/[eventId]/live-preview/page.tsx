import { LiveView } from "@/app/(public)/tickets/[ticketNumber]/_components/live/live-view";

/**
 * 🔴 라이브 미리보기 — **주최자만** 본다.
 *
 * ## 왜 이 화면이 필요한가
 *
 * 2026-08-06 ~ 08-19 리허설 기간에는 원천이 **다른 대회의 실제 스코어**를
 * `is_rehearsal: true` 로 보낸다. 관중 화면은 그걸 막는다(fail-closed) — 그래서
 * **우리도 화면을 볼 방법이 없다.** 대회 전에 화면이 도는지 확인할 수단이 사라진다.
 *
 * ⟹ 주최자 로그인 뒤에 같은 화면을 한 번 더 둔다. **경로 자체가 권한**이다.
 *
 * ⚠️ URL 파라미터(`?rehearsal=1`)로 만들지 않았다. 링크가 한 번 새면 되돌릴 수 없고,
 *    알림톡·카톡으로 퍼진다. 로그인 뒤에 두면 기존 권한 체계가 그대로 지킨다.
 *
 * 🔴 `organizerEventId` 는 **서버에서만** 넘어간다. 공개 티켓 경로는 이 값을 안 넘기므로
 *    관중 화면의 리허설 차단은 그대로다.
 */
export default async function LivePreviewPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-content-default">
        <b>라이브 미리보기</b> — 주최자 전용입니다. 리허설 기간에는 <b>다른 대회</b>의
        실시간 데이터가 보입니다. 관중 화면에는 나가지 않습니다.
      </div>
      <LiveView
        ticketNumber=""
        organizerEventId={eventId}
        eventTitle="라이브 미리보기"
        ticketPanel={
          <div className="px-4 py-8 text-center text-sm text-content-muted">
            티켓 화면은 관중 경로에서만 표시됩니다.
          </div>
        }
        schedules={[]}
      />
    </div>
  );
}

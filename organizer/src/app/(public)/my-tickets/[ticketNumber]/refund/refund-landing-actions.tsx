import Link from "next/link";
import { Button } from "@/components/ui/button";
import { eventPagePath } from "@/lib/public/event-path";

/**
 * 환불 절차가 끝난 뒤 **갈 곳**.
 *
 * ## 🔴 여기서 길이 끊겨 있었다 (2026-08-01, 대표 실사용 지적)
 * 「환불이 완료되었습니다」만 뜨고 **버튼이 하나도 없었다.** 뒤로가기 말고는 갈 데가 없다.
 * 환불한 사람이 다른 날짜로 다시 사는 일은 흔한데(주중권 15,000 ↔ 주말권 25,000)
 * 그 길이 막혀 있었다.
 *
 * ## ⚠️ 왜 별도 컴포넌트인가
 * 환불 화면의 완료 상태는 컴포넌트 **내부 state(step 4)** 라 서버 렌더로 도달할 수 없다.
 * 지시서가 요구한 대로 **렌더 결과의 `href` 값**을 단언하려면 이 조각이 따로 있어야 한다.
 * (문자열 존재 검사는 한 줄로 우회된다 — 오늘 실제로 뚫리는 걸 봤다.)
 */
export function RefundLandingActions({ eventSlug }: { eventSlug?: string | null }) {
  // 슬러그를 모르면 행사 버튼을 **그리지 않는다** — `/e/undefined` 로 보내지 않는다.
  const eventHref = eventPagePath(eventSlug);
  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
      {eventHref ? (
        <Button asChild>
          <Link href={eventHref}>행사 페이지로</Link>
        </Button>
      ) : null}
      <Button asChild variant="outline">
        <Link href="/my-tickets">내 티켓 조회</Link>
      </Button>
    </div>
  );
}

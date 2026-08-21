import Link from "next/link";
import { Button } from "@/components/ui/button";
import { eventPagePath } from "@/lib/public/event-path";

/**
 * 못 쓰는 티켓(환불·취소 / 만료 / 양도됨)을 열었을 때 **갈 곳**.
 *
 * ## 🔴 여기도 길이 끊겨 있었다 (2026-08-02, 대표 실사용 지적)
 * `!usability.usable` 갈래는 문의 메일 링크 하나뿐이었다. 달력·지도·환불 링크는
 * 전부 **사용 가능** 갈래에만 있다(early return 으로 갈라진다).
 *
 * 환불한 사람이 이 화면을 다시 여는 일은 흔하다 — 「내 티켓」에서 옛 티켓을 눌러본다.
 * 거기서 다른 날짜를 다시 사려 해도(주중권 15,000 ↔ 주말권 25,000) 갈 길이 없었다.
 *
 * ## ⚠️ 왜 별도 컴포넌트인가
 * 환불 완료 화면(`refund-landing-actions.tsx`)과 같은 이유다 — **렌더 결과의 `href`
 * 값**을 단언하려면 조각이 따로 있어야 한다. 문자열 존재 검사는 한 줄로 우회된다.
 */
export function TicketUnusableActions({ eventSlug }: { eventSlug?: string | null }) {
  // 슬러그를 모르면 행사 버튼을 **그리지 않는다** — `/e/undefined` 로 보내지 않는다.
  const eventHref = eventPagePath(eventSlug);
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
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

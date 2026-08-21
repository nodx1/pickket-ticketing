/**
 * GET /api/public/events/[slug]/calendar
 * .ics 파일 다운로드 (Apple Calendar / Outlook)
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `SELECT ... FROM events WHERE slug=$1 AND status='live'` → v2 by-slug live read.
 * 상태 게이트(live)는 유지한다 — draft/paused 이벤트의 일정이 새 나가면 안 된다.
 * v2 장애는 404 로 뭉개지 않고 **503**(재시도 가능)으로 통지한다.
 */
import { NextRequest } from "next/server";
import { generateIcs } from "@/lib/calendar/links";
import {
  PUBLIC_LIVE_STATUSES,
  resolvePublicEventBySlug,
} from "@/lib/v2/public-event";

type Params = { slug: string };

export async function GET(_request: NextRequest, context: { params: Promise<Params> }) {
  const { slug } = await context.params;

  const resolved = await resolvePublicEventBySlug(slug, PUBLIC_LIVE_STATUSES);
  if (!resolved.ok) {
    return new Response(resolved.error, { status: resolved.status });
  }
  const event = resolved.event;

  const startsAt = event.event_date;
  if (!startsAt) {
    // 일정 없는 이벤트의 .ics 는 의미가 없다(빈 시각으로 만들면 캘린더가 깨진다).
    return new Response("이벤트 일정이 아직 확정되지 않았습니다", { status: 404 });
  }
  // go ends_at 대응 = v2 event_date_end(다일 이벤트). 단일일 이벤트는 시작=종료.
  const endsAt = event.event_date_end ?? startsAt;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://go.pickket.kr";

  const ics = generateIcs({
    title: event.title,
    startsAt,
    endsAt,
    venueName: event.venue ?? null,
    venueAddress: event.venue_address ?? null,
    // go events.summary 는 v2 상세의 content.summary 로 흡수됐다(없으면 description 폴백).
    description:
      (typeof event.content?.summary === "string" ? event.content.summary : null) ??
      event.description ??
      null,
    url: `${appUrl}/e/${slug}`,
  });

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}.ics"`,
    },
  });
}

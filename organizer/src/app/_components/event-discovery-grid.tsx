import { EVENT_TYPE_LABELS } from "@/lib/constants";
import { listPublicEventsV2 } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";
import { EventDiscoveryGridClient, type EventCardData } from "./event-discovery-grid-client";

/**
 * ── 레벨2 컷오버 W2-PUB ──
 * go `events + attendees COUNT` → v2 공개 목록 read(참석자수는 v2 서버사이드 집계).
 * 상태 게이트(live)는 v2 가 강제한다.
 *
 * 실패 정책: 랜딩 그리드는 페이지 전체를 죽이지 않고 **빈 상태 + 로그**로 간다.
 * 이 컴포넌트는 `<Suspense>` 안의 장식 섹션이고, throw 하면 홈 전체가 500 이 된다.
 * ⚠️ 단 "판매중 이벤트 0건"과 구분되도록 클라이언트에 `degraded` 를 넘겨 안내를 띄운다
 *    (조용한 빈 목록 금지 — wave1 결함 재발 방지).
 */
export async function EventDiscoveryGrid() {
  let events: EventCardData[] = [];
  let degraded = false;

  try {
    const result = await listPublicEventsV2({ sort: "date", limit: 24 });
    events = result.events.map((row) => ({
      id: row.event_id,
      slug: row.slug,
      title: row.title,
      startsAt: row.event_date,
      venueName: row.venue,
      heroImageUrl: row.image_url,
      eventType: row.event_type ?? "",
      attendeeCount: row.attendee_count,
    }));
  } catch (err: unknown) {
    degraded = true;
    logger.warn("랜딩 이벤트 그리드 v2 조회 실패", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  const types = Object.entries(EVENT_TYPE_LABELS).slice(0, 8) as Array<[string, string]>;

  return <EventDiscoveryGridClient events={events} types={types} degraded={degraded} />;
}

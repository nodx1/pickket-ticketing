import type { Pool } from "pg";

import { fetchPublishedMaps } from "@/lib/v2/seat-map-payload";
import { V2CommerceError, listSeats, listTierCatalog } from "@/lib/v2/commerce-client";
import { getOwnedEvent } from "@/lib/v2/event-access";

/**
 * 게시 준비도 판정 — 온보딩 가이드(getting-started)와 게시 게이트(publish-check)의 SSOT.
 *
 * 배경(감사 P0-12): 온보딩 가이드는 products COUNT 로 "티켓" 스텝을 판정했지만, 실제 게시 게이트는
 * seat_tiers + 배치도(seat_maps published) 기준이라 가이드를 100% 따라도 게시가 실패했다.
 * 두 화면이 이 헬퍼의 동일 카운트/판정을 공유해 일관성을 보장한다.
 */
export interface TicketReadiness {
  productCount: number;
  tierCount: number;
  seatCount: number;
  publishedMapCount: number;
  /** publish 게이트의 "티켓(좌석 등급)" 판정: 등급 존재 + 배치도 발행이면 pass. */
  ticketStatus: "pass" | "warn" | "fail";
}

/**
 * 이벤트의 티켓/좌석 게시 준비 카운트 + 판정을 반환한다(테넌트 경계 필수 — 크로스테넌트 차단).
 *
 * @throws EventAccessError(reason="unavailable") v2 응답불가로 **소유 확인 자체가 불가**할 때.
 *   좌석/배치도 조회 실패(V2CommerceError)는 0 으로 폴백하지만, 소유 확인 실패는 폴백하지 않는다 —
 *   "확인 불가"를 "없음(0건)"으로 표시하면 주최자에게 등급이 사라진 것처럼 보인다.
 */
export async function getTicketReadiness(
  pool: Pool,
  eventId: string,
  accountId: string,
): Promise<TicketReadiness> {
  // ── 레벨2 컷오버 T2-EVT — go events 앵커/소유 조회 폐기(go event id == v2 event id) ──
  // 옛 `WHERE e.id=$1 AND e.account_id=$2` 테넌트 경계는 v2 가 `organizer_ref` 로 강제한다.
  // 🔴 순서가 곧 경계다: events 조인을 걷어낸 카운트 쿼리에는 account_id 조건이 없으므로
  //    **소유 확인이 통과한 뒤에만** products/seat_tiers 를 집계한다(뒤집으면 크로스테넌트 카운트 누출).
  const event = await getOwnedEvent(eventId, accountId);
  if (!event) {
    // 없거나 내 계정 소유 아님 — 옛 "rows 빈 → 전부 0, 에러 아님" 과 동일. v2 좌석/배치도도 조회하지 않는다.
    return {
      productCount: 0,
      tierCount: 0,
      seatCount: 0,
      publishedMapCount: 0,
      ticketStatus: "fail",
    };
  }

  // ── 레벨2 컷오버 W2-PS — 상품·좌석등급 정본은 **v2 tier 카탈로그** ──
  // 🔴 실장애(2026-07-27): 여기가 go `products`/`seat_tiers` 를 세고 있었다. W2-PS 가 등급/상품
  //    생성을 v2 카탈로그 단독 write 로 옮겨 go 테이블에는 새 행이 **더 이상 생기지 않는데**,
  //    게시 판정만 옛 테이블을 보고 있었다. prod 초기화로 그 테이블이 비자 tierCount 가 항상 0 →
  //    "좌석 등급을 추가하세요"가 영구 표시되고 **아무도 이벤트를 게시할 수 없었다**.
  //    (등급을 실제로 만들어도 화면은 계속 미충족이라 원인을 알 수 없다.)
  //    ⟹ 카탈로그 1회 조회로 상품/등급을 함께 센다. `products` 는 tier 중 상품 성격
  //       (metadata.go_source='product')인 것, 그 외는 좌석등급으로 본다.
  //
  // v2 일시오류는 게시 가이드를 막지 않도록 0 으로 폴백한다(판정이 fail/warn 로 보수적으로 기울 뿐).
  void pool; // go DB 미사용 — 시그니처는 호출부 호환을 위해 유지한다.

  // ⚠️ 카탈로그와 좌석/배치도는 **실패 정책이 다르므로 분리**한다.
  //    카탈로그(등급 수)는 게시 게이트를 좌우한다 — 조회 실패를 0 으로 흘리면 등급이 있는데도
  //    "좌석 등급을 추가해주세요" 가 떠서 주최자가 원인을 못 찾는다(이 파일이 고친 바로 그 증상).
  //    ⟹ 카탈로그 실패는 전파한다("확인 불가"를 "없음"으로 표시하지 않는다).
  //    좌석/배치도는 부가 지표라 종전대로 0 폴백(판정이 보수적으로만 기운다).
  const catalog = await listTierCatalog(event.event_id);
  let productCount = 0;
  let tierCount = 0;
  for (const tier of catalog.tiers) {
    const src = (tier.tier_metadata as { go_source?: string } | null)?.go_source;
    if (src === "product") productCount += 1;
    else tierCount += 1;
  }

  let seatCount = 0;
  let publishedMapCount = 0;
  try {
    const [seats, maps] = await Promise.all([
      listSeats(event.event_id, { limit: 1 }),
      fetchPublishedMaps(event.event_id),
    ]);
    seatCount = seats.total_seats;
    publishedMapCount = maps.length;
  } catch (err: unknown) {
    if (!(err instanceof V2CommerceError)) throw err;
  }

  const ticketStatus: TicketReadiness["ticketStatus"] =
    tierCount > 0 && publishedMapCount > 0 ? "pass" : tierCount > 0 ? "warn" : "fail";

  return { productCount, tierCount, seatCount, publishedMapCount, ticketStatus };
}

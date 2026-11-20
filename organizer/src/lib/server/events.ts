import { getPool } from "@/lib/db/pool";
import type { EventStatus } from "@/lib/types";
import {
  listTierCatalog,
  listEventHostLinks,
  listPublicNotices,
  listEventQuestions,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import {
  selectPublicTiers,
  tierIsOnSale,
  tierRemainingStock,
  tierTotalCapacity,
} from "@/lib/public/tier-view";
import { getOwnedEvent, getPublicEventBySlugV2 } from "@/lib/v2/event-access";
import { parseV2Schedules } from "@/lib/v2/event-schedules";
import { toGoEventView } from "@/lib/v2/event-view";
import { PUBLIC_LIVE_STATUSES } from "@/lib/v2/public-event";
import { hasLotteryPhase } from "@/lib/v2/phase-client";
import { fetchV2SeatLiveMap } from "@/lib/seats/v2-status";

/**
 * 레벨2 read-flip — checkout 표시/PG 금액을 v2 tier 정본으로 공급하지 못한 상황.
 * getPublicEventBySlug({ authoritativePricing: true }) 경로에서만 발생하며, 호출부(체크아웃 페이지)가
 * 명시적 409/502 로 중단하기 위한 타입드 에러다. go products.price 를 표시/PG 금액으로 흘려보내면
 * 서버 initiate(v2 tier.base_price)와 불일치 → v2 AMOUNT_MISMATCH 로 결제 진입이 실패하므로,
 * 표시 단계에서 미리 차단한다(조용한 go 금액 강등 금지).
 */
export class CheckoutPricingError extends Error {
  /** 커머스(v2) 미연결/앵커 부재·상품 티어 매칭 실패 → 409. v2 read 실패 → 502. */
  readonly httpStatus: 409 | 502;
  constructor(message: string, httpStatus: 409 | 502) {
    super(message);
    this.name = "CheckoutPricingError";
    this.httpStatus = httpStatus;
  }
}

export interface OrganizerEntry {
  organizerId: string;
  name: string;
  role: string;
  displayOrder: number;
}

export interface EventSummary {
  id: string;
  organizerId: string;
  title: string;
  slug: string;
  status: EventStatus;
  organizerName: string;
  organizers: OrganizerEntry[];
  startsAt: string;
  endsAt: string;
  venueName: string | null;
  venueAddress: string | null;
  /** 「장소 찾기」로 고른 좌표(지도 API 연동). 없으면 null. */
  venueLat: number | null;
  venueLng: number | null;
  eventType: string;
  ageRating: string;
  maxAttendees: number | null;
  isOnline: boolean;
  summary: string | null;
  description: string | null;
  heroImageUrl: string | null;
  imageVariants: Record<string, string> | null;
  galleryImages: Array<{ url: string; variants?: Record<string, string> | null }> | null;
  transportInfo: string | null;
  /** 프로그램 탭 자유문구 — v2 노출 전까지 null 로 온다(그 상태가 정상 동작이어야 한다). */
  programNotes: string | null;
  stageInfo: string | null;
  parkingInfo: string | null;
  enabledFeatures: string[];
  hasLotteryPhase: boolean;
  /** F4 경품 추첨 활성화 여부(go-local). 추첨 사이드바 항목/화면 게이트. */
  raffleEnabled: boolean;
  /** 판매 채널(self·marketplace…). marketplace 면 승인 뒤 피켓에 공개된다 — 사이드바 「피켓에서 보기」. */
  saleChannels: string[];
}

/**
 * 주최자 워크스페이스 공통 이벤트 요약 (레벨2 컷오버 W2-EVT — go `events` SELECT 제거).
 *
 * 소유 경계는 v2 `organizer_ref` 가 강제한다(불일치 → null → 호출 페이지가 notFound()).
 *
 * 🔴 v2 장애는 **null 로 흡수하지 않는다** — `EventAccessError(reason="unavailable")` 를 그대로
 *    던진다. null 로 뭉개면 워크스페이스가 "이벤트 없음(404)"을 렌더해 주최자가 데이터 유실로
 *    오인한다. 서버 컴포넌트 호출부는 에러 바운더리(500)로 떨어지는 편이 정직하다.
 */
export async function getEventSummary(
  eventId: string,
  accountId: string,
): Promise<EventSummary | null> {
  const event = await getOwnedEvent(eventId, accountId);
  if (!event) return null;

  // 주최자 표기(옛 event_organizers JOIN organizers) → v2 event_host_links.
  // 표기 조회 실패는 화면 전체를 막지 않는다(요약은 이미 확보) — 빈 목록으로 렌더.
  let organizers: OrganizerEntry[] = [];
  try {
    const { hosts } = await listEventHostLinks(accountId, event.event_id);
    organizers = hosts.map((h) => ({
      organizerId: h.host_id,
      name: h.name,
      role: h.role,
      displayOrder: h.display_order,
    }));
  } catch (err: unknown) {
    if (!(err instanceof V2CommerceError)) throw err;
  }
  const primary = organizers.find((o) => o.role === "host") ?? organizers[0] ?? null;

  const view = toGoEventView(event);
  return {
    ...view,
    id: view.id,
    status: view.status as EventStatus,
    eventType: view.eventType ?? "",
    ageRating: view.ageRating ?? "",
    startsAt: view.startsAt ?? "",
    endsAt: view.endsAt ?? "",
    organizerId: primary?.organizerId ?? "",
    organizerName: primary?.name ?? "",
    organizers,
    // 추첨 계열 단계 존재 여부 = 사이드바 추첨 메뉴 게이트. v2 조회 실패 시 false 폴백.
    hasLotteryPhase: await hasLotteryPhase(eventId, accountId),
  };
}

// T2-ORD: getEventDashboardStats 제거 — 호출자 0(dead). 대시보드는 v2 getEventDashboard 가
// 정본이며(app/api/events/[eventId]/dashboard/route.ts), 이 함수만 go orders/attendees/
// products/order_items 를 직접 집계해 stale 수치를 재생산할 위험이 있었다.

/**
 * 공개 상세의 상품 1행. (W4-EVT: 옛 `...event`(any) 스프레드가 반환 타입을 통째로
 * any 로 붕괴시켜 호출부가 무검증이었다 — 이벤트를 v2 타입으로 바꾸면서 상품도 명시한다.)
 * 정본은 v2 tier 카탈로그다(W2-PS 이후 go `products` 에는 새 행이 생기지 않는다).
 *
 * 🔴 재고 3필드의 이름과 뜻(감사 F-6, 2026-07-28):
 *   · `stock`     = **잔여**(= capacity − sold_count). `null` = 무제한.
 *   · `capacity`  = **총좌석**(집행값). `null` = 무제한. ← 이 필드가 없어서 공개 API 의
 *                   `capacity: p.capacity ?? p.stock` 이 조용히 **잔여**를 총좌석으로 내보냈다.
 *   · `soldCount` = 판매수(환불 제외).
 */
interface PublicProductRow {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  /**
   * 정가(할인 전). 화면에서 **취소선**으로 쓴다.
   *
   * 🔴 `null` 이거나 `price` 와 같으면 **아무것도 그리지 않는다**(`face-price.ts` 규칙).
   *    정가가 없는 행사에 `~~₩0~~` 이나 `~~₩13,500~~ ₩13,500` 이 뜨면 그게 더 큰 사고다.
   */
  facePrice: number | null;
  /** 잔여 재고(= capacity − sold_count). `null` = 무제한. */
  stock: number | null;
  /** 총좌석(집행 capacity). `null` = 무제한. 잔여가 아니다. */
  capacity: number | null;
  /** 환불 제외 판매수(v2 SoT). */
  soldCount: number;
  taxIncluded: boolean;
  taxRate: number | string | null;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  isOnSale: boolean;
  minPerOrder: number | null;
  maxPerOrder: number | null;
  type: string | null;
  /** v2 등급 판매 방식(point_lottery·fanclub_presale 이면 피켓 응모 등급 — lib/public/lottery-cta). */
  saleMode: string | null;
}

export async function getPublicEventBySlug(
  slug: string,
  opts: { includeSeats?: boolean; authoritativePricing?: boolean } = {},
) {
  // includeSeats=false 면 개별 좌석(최대 수천 행)을 페이로드에 싣지 않는다. 고트래픽 ISR 경로
  // (이벤트 상세·embed 등)는 좌석맵 개별좌석이 필요 없으므로 생략해 페이로드/렌더 비용을 줄인다.
  // 좌석 선택이 필요한 체크아웃 단계만 seats 를 받거나 /api/public/events/[slug]/seats 로 조회한다.
  // (감사 P1-25)
  //
  // authoritativePricing=true(체크아웃 경로 전용): 상품 표시 가격(products.price)을 v2 tier.base_price
  // 정본으로 덮어써 표시/선택/PG 금액을 서버 initiate(v2)와 일치시킨다. v2 미앵커·티어 매칭 실패·
  // v2 read 실패 시 CheckoutPricingError 로 중단(호출부 409/502) — go 금액으로 조용히 강등하지 않는다.
  // (레벨2 read-flip: go products.price 표시 직접의존 폐기.)
  const includeSeats = opts.includeSeats ?? true;
  const authoritativePricing = opts.authoritativePricing ?? false;
  // 🔴 go DB 커넥션을 더 이상 잡지 않는다. 참여자 수 집계(go `attendees` COUNT)를 걷어내면서
  //    이 함수의 go 조회가 **0** 이 됐다 — 공개 상세는 이제 v2 read 만으로 구성된다(컷오버 진척).

  // ── 레벨2 컷오버 W4-EVT — 공개 상세의 이벤트 본문을 v2 by-slug read 로 전환 ──
  // 옛 `SELECT ... FROM events WHERE slug=$1 AND status='live'` 의 1:1 대체다.
  // · 상태 게이트(`live`)는 **호출측 판정**으로 보존한다(v2 by-slug 는 하드 필터하지 않는다).
  //   게이트 탈락은 미존재와 동일하게 null — draft/paused 이벤트를 공개 경로에 흘리지 않는다.
  // 🔴 v2 장애는 null(=404) 로 뭉개지 않는다. `getPublicEventBySlugV2` 가 던지는
  //    EventAccessError(unavailable) 를 그대로 전파한다 — "판매중인 이벤트가 사라진 화면"을
  //    조용히 렌더하는 것보다 에러로 끊는 편이 정직하다. JSON 라우트는 이를 503 으로 변환한다.
  const detail = await getPublicEventBySlugV2(slug);
  if (!detail || !(PUBLIC_LIVE_STATUSES as readonly string[]).includes(detail.status)) {
    return null;
  }

  // go 컬럼 → v2 필드 매핑은 toGoEventView 한 곳에서만 한다(라우트별 필드명 분기 방지).
  const view = toGoEventView(detail);
  // 옛 응답의 `accountId`(소유 테넌트) = v2 `go_account_id`.
  const accountId = detail.go_account_id ?? null;
  // 🔴 참석자 수 집계 제거(2026-07-28). 공개 페이지의 "N명 참여 예정" 뱃지를 걷어내면서
  //    함께 뺀다. 이 COUNT 는 **상태 필터가 없어** 취소·환불·대기 참석자까지 세고 있었고
  //    (실측: 유효 0명인데 5로 표시), 대상 테이블 go `attendees` 는 컷오버 폐기 대상이라
  //    정본도 아니었다. 다시 필요해지면 v2 유효 티켓(active/used) 기준으로 세야 한다.
  //    ⟹ 이 함수의 go DB 조회가 하나 줄어든다(컷오버 진척).

  const event = {
    ...view,
    // 옛 호출부 호환 — ID 승격 이후 v2EventId 는 id 와 같은 값이다.
    v2EventId: detail.event_id,
    accountId,
    organizers: [] as OrganizerEntry[],
    organizerName: null as string | null,
  };

  // ── 레벨2 컷오버 W2-EVT — 주최자 표기는 v2 `event_host_links` 가 정본 ──
  // go `organizers`/`event_organizers` JOIN 을 제거했다(마이그 240 에서 DROP).
  // 공개 경로라 세션이 없으므로 소유 테넌트(go_account_id)를 organizer_ref 로 넘긴다.
  // ⚠️ 여기서만 관대하게 폴백한다: 주최자 표기는 부가정보라 v2 일시오류에 페이지 전체를
  //    떨어뜨리지 않고 표기만 비운다(좌석 배치도와 동일 정책).
  //    이벤트 본문 자체는 위에서 이미 하드 게이트했다(없으면 애초에 렌더 불가).
  if (accountId) {
    try {
      const { hosts } = await listEventHostLinks(accountId, detail.event_id);
      event.organizers = hosts.map((h) => ({
        organizerId: h.host_id,
        name: h.name,
        role: h.role,
        displayOrder: h.display_order,
      }));
      event.organizerName = hosts.find((h) => h.role === "host")?.name ?? hosts[0]?.name ?? null;
    } catch (err: unknown) {
      if (!(err instanceof V2CommerceError)) throw err;
    }
  }

  // ── 레벨2 컷오버 W2-PS — 공개 상품 목록 정본은 **v2 tier 카탈로그** ──
  // 🔴 2026-07-27 prod 실검증에서 발견. 여기가 go `products` 를 읽고 있었다. W2-PS 가 상품·좌석등급
  //    생성을 v2 카탈로그 단독 write 로 옮겨 go 테이블에는 새 행이 **생기지 않는다** ⟹ 초기화된
  //    DB 에서 공개 페이지의 products 가 **항상 빈 배열**이 됐고, 그 결과:
  //      · `totalStock = 0` → `isSoldOut = true` → 버튼이 **"매진되었습니다"** 로 표시
  //      · 즉 티켓을 정상 등록해도 **아무도 살 수 없고**, 화면은 "매진"이라 원인을 알 수 없다.
  //    (판매 전/매진/미등록이 전부 같은 화면으로 보이는 것이 이 결함을 감췄다.)
  //
  //  v2 tier → 공개 상품 뷰 매핑:
  //   · stock = `stock_limit`(원본 재고). `capacity` 는 무제한 sentinel(1,000,000)이 섞여 있어
  //     그대로 쓰면 "재고 100만"이 된다. null = 무제한.
  //   · isOnSale = 판매창(sale_window) 기준. 티어에 창이 없으면 이벤트 판매창을 따른다.
  let catalog: Awaited<ReturnType<typeof listTierCatalog>>;
  try {
    catalog = await listTierCatalog(detail.event_id);
  } catch (err: unknown) {
    // 🔴 실패를 "상품 0건"으로 흘리지 않는다 — 그러면 화면이 **"매진"** 으로 보인다(이 결함의 핵심).
    //    체크아웃 경로는 기존 계약대로 CheckoutPricingError(502), 그 외는 그대로 전파.
    if (authoritativePricing && err instanceof V2CommerceError) {
      throw new CheckoutPricingError(`상품 가격 정보를 불러오지 못했습니다 (v2: ${err.message})`, 502);
    }
    throw err;
  }
  const nowMs = Date.now();
  // 🔴 필터·잔여 계산은 `lib/public/tier-view.ts` 한 곳에만 둔다(감사 F-5). 위젯 embed 경로가
  //    이 규칙을 복붙하지 않고 **같은 함수**를 쓰게 하기 위해서다 — 복붙이 갈라진 결과가
  //    "상세는 고쳤는데 위젯만 go products 를 읽어 상품 0개"였다.
  //
  // `stock` = **잔여**(= capacity − sold_count), `capacity` = **총좌석**. 둘 다 무제한은 null.
  // 판매를 실제로 막는 기준이 v2 `internal_commerce.py:3980` 의 `capacity − sold_count` 라
  // 표시도 같은 식을 쓴다(같은 판정을 toss/confirm 도 쓴다). 상세 근거는 tier-view.ts 주석.
  const products: PublicProductRow[] = selectPublicTiers(catalog.tiers).map((t) => ({
    id: t.external_ref ?? t.tier_id,
    name: t.name,
    description: t.description,
    price: Number(t.base_price),
    // v2 원장의 정가. 시딩이 없으면 null 로 흘러 화면에서 아무것도 안 그린다.
    facePrice: t.face_price != null ? Number(t.face_price) : null,
    stock: tierRemainingStock(t),
    capacity: tierTotalCapacity(t),
    soldCount: Number(t.sold_count ?? 0),
    taxIncluded: t.tax_included ?? true,
    taxRate: t.tax_rate,
    saleStartsAt: t.sale_window?.opens_at ?? null,
    saleEndsAt: t.sale_window?.closes_at ?? null,
    isOnSale: tierIsOnSale(t, nowMs),
    minPerOrder: t.min_per_order,
    maxPerOrder: t.max_per_order,
    type: t.product_type,
    saleMode: t.sale_mode ?? null,
  }));

  // ⚠️ 옛 "authoritativePricing 이면 go price 를 v2 tier.base_price 로 덮어쓴다" 블록은 **삭제**했다.
  //    products 자체가 이제 v2 카탈로그에서 나오므로 가격이 이미 정본이고, 덮어쓰기는 같은 값을
  //    다시 쓰는 중복 왕복이었다. 불일치 가능성 자체가 사라졌으므로 409(해석 불가) 분기도 소멸한다.

  // ── 레벨2 컷오버 W5-ATTENDEE — 예매 설문 문항을 v2(정본)에서 읽는다 ──
  // 옛 `SELECT ... FROM event_questions` 폐기. 공개 상세라 organizer_ref 없이 조회한다
  // (문항 정의는 이미 소비자 `EventResponse.questions` 로 공개되는 데이터).
  //
  // 🔴 fail-closed: 조회 실패를 **빈 목록으로 강등하지 않는다**. 체크아웃에서 빈 설문은
  //    "이 행사는 설문이 없다"로 읽혀 필수 문항을 건너뛴 채 결제로 넘어간다. 가격 강등과
  //    같은 등급의 사고이므로 같은 방식(CheckoutPricingError 502)으로 중단한다.
  let questionRows: Array<{
    id: string;
    label: string;
    questionType: string;
    isRequired: boolean;
    options: string[];
    sortOrder: number;
  }>;
  try {
    const { questions } = await listEventQuestions(detail.event_id);
    questionRows = questions.map((q) => ({
      id: q.id,
      label: q.label,
      questionType: q.question_type,
      isRequired: q.is_required,
      options: q.options,
      sortOrder: q.sort_order,
    }));
  } catch (err: unknown) {
    const reason = err instanceof V2CommerceError ? `: ${err.message}` : "";
    throw new CheckoutPricingError(`예매 설문 정보를 불러오지 못했습니다 (v2${reason})`, 502);
  }

  // ── 레벨2 컷오버 T1 — 배치도·좌석을 v2 에서 read(go seat_maps/seats 미read) ──
  // 배치도 원본은 v2 events.seat_map_data(SoT). 이 함수는 **공개/체크아웃 상세**를 만들므로
  // published 를 우선하고, 없으면 draft 로 폴백한다(기존 `status IN ('draft','published')` 동작 보존).
  // ⚠️ draft 폴백은 이 응답이 소유자 프리뷰/체크아웃 구성에도 쓰이기 때문이며, 순수 공개 목록
  //    (public/seat-maps)은 published 만 노출한다(fetchPublishedMaps).
  // ⚠️ 레벨2 W2-EVT — go event id == v2 event id(항등)라 옛 `events.v2_event_id` 앵커 컬럼을
  //    더 이상 읽지 않는다. 같은 v2 상세 응답에서 **타임테이블**도 함께 꺼낸다(왕복 1회 유지).
  let activeSeatMap:
    | { id: string; name: string; status: string; mapData: Record<string, unknown> | null }
    | undefined;
  let seatRows: Array<{
    id: string;
    section: string;
    row: string;
    seatNumber: string;
    status: string;
  }> = [];
  // go `event_schedules` 테이블 → v2 `events.event_schedules`(JSONB). 마이그 240 에서 DROP.
  let schedules: Array<{
    id: string;
    title: string;
    description: string | null;
    startsAt: string;
    endsAt: string | null;
    venueName: string | null;
    sortOrder: number;
    /** 일정에 딸린 안내 이미지(조편성표 등). 공개 상세 프로그램·일정 탭이 쓴다. */
    imageUrl: string | null;
  }> = [];

  // ⚠️ W4-EVT — 이벤트 본문을 이미 v2 by-slug 로 읽었으므로 **같은 응답**에서 타임테이블·배치도를
  //    꺼낸다(옛 `getEvent(event.id)` 재조회 왕복 제거). 따라서 여기서는 v2 실패 폴백이 필요 없다 —
  //    본문을 못 읽었으면 애초에 위에서 EventAccessError 로 끊겼다.
  schedules = parseV2Schedules((detail.content ?? {}).event_schedules);
  const maps = detail.content?.seat_map_data?.maps ?? [];
  const picked =
    maps.find((m) => m.status === "published") ?? maps.find((m) => m.status === "draft");
  if (picked) {
    activeSeatMap = {
      id: picked.id,
      name: picked.name,
      status: picked.status,
      mapData: (picked.map_data ?? null) as Record<string, unknown> | null,
    };
    if (includeSeats) {
      try {
        const live = await fetchV2SeatLiveMap(detail.event_id);
        seatRows = [...live.byGoSeatId.values()]
          .map((st) => ({
            id: st.seatId,
            section: st.section,
            row: st.row,
            seatNumber: st.seatNumber,
            status: st.status,
          }))
          .sort(
            (a, b) =>
              a.section.localeCompare(b.section) ||
              a.row.localeCompare(b.row) ||
              (Number(a.seatNumber) || 0) - (Number(b.seatNumber) || 0),
          );
      } catch (err: unknown) {
        // 좌석 **실시간 상태**만 v2 일시오류 → 좌석 목록 비움(배치도·상세 렌더는 비차단).
        // 금액 경로(authoritativePricing)는 위에서 이미 하드 게이트했다.
        if (!(err instanceof V2CommerceError)) throw err;
      }
    }
  }

  // 공개 공지 (is_published=true만, 최신순)
  // ── 레벨2 컷오버 W5-CONTENT — go `open_notices` → v2 `organizer_open_notices` ──
  //   v2 public-content 는 **발행(is_published=true) 공지만** 내려준다(미발행 초안 노출 불가).
  //   🔴 실패를 빈 배열로 삼키지 않는다. 취소·환불 공지가 조용히 사라지면 소비자가 잘못된
  //      정보로 구매한다. 어차피 이 함수는 이벤트 본문 자체를 이미 v2 에서 읽어왔으므로
  //      v2 가 죽으면 여기까지 오지도 않는다 — 전파해도 가용성 손해는 없고 거짓말만 막는다.
  const { notices } = await listPublicNotices(detail.event_id, 10);

  return {
    ...event,
    products,
    questions: questionRows,
    seatMap: activeSeatMap
      ? {
          ...activeSeatMap,
          seats: seatRows,
        }
      : null,
    schedules,
    notices: notices.map((n) => ({
      id: n.id,
      type: n.notice_type,
      title: n.title,
      content: n.content,
      publishedAt: n.published_at,
      createdAt: n.created_at,
    })),
  };
}

/**
 * 결제완료 화면용 주문 요약 (레벨2 컷오버 W4-EVT — go `orders INNER JOIN events` 제거).
 *
 * 옛 JOIN 은 두 가지 일을 했다: ① `events.title` 표시, ② `events.slug = $2` 로 URL 의 slug 와
 * 주문의 이벤트가 일치하는지 검증(주문 id 만 알면 남의 이벤트 URL 로 열람되는 것을 막는 게이트).
 * 둘 다 v2 로 옮긴다 — slug → v2 이벤트(제목·id) → 그 id 로 go 주문을 스코프.
 *
 * ⚠️ 상태 게이트는 두지 않는다. 결제완료 화면은 판매가 끝난(paused/archived) 뒤에도 열려야 한다
 *    — 옛 JOIN 도 status 를 보지 않았다(동작 동일).
 * 🔴 v2 장애는 null(=주문 없음)로 뭉개지 않는다. EventAccessError 를 전파해 호출 페이지가
 *    "주문이 없다"고 거짓말하지 않게 한다.
 */
export async function getPublicOrderCompletion(orderId: string, eventSlug: string) {
  const pool = getPool();

  const event = await getPublicEventBySlugV2(eventSlug);
  if (!event) return null;

  const orderResult = await pool.query(
    `
      SELECT
        orders.id,
        orders.order_number AS "orderNumber",
        orders.buyer_name AS "buyerName",
        orders.total_amount AS "totalAmount",
        orders.payment_method AS "paymentMethod",
        orders.status AS "status"
      FROM orders
      WHERE orders.id = $1 AND orders.event_id = $2
      LIMIT 1
    `,
    [orderId, event.event_id],
  );

  if (orderResult.rows.length === 0) {
    return null;
  }

  const attendeeResult = await pool.query(
    `
      SELECT ticket_number AS "ticketNumber"
      FROM attendees
      WHERE order_id = $1
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [orderId],
  );

  return {
    ...orderResult.rows[0],
    eventTitle: event.title,
    ticketNumber: attendeeResult.rows[0]?.ticketNumber ?? null,
  };
}

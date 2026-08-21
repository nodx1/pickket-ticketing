/**
 * 위젯 embed 설정(공개) — 외부 사이트에 심는 구매 위젯이 읽는다.
 *
 * ── 레벨2 컷오버 W4-EVT ──
 * go `SELECT id, title, starts_at, ends_at, venue_name, hero_image_url FROM events
 *      WHERE slug=$1 AND status='live'` → v2 by-slug live read + 동일 상태 게이트.
 * 🔴 v2 장애를 404 로 뭉개지 않는다 — 외부 사이트의 위젯이 "행사 없음"을 렌더하면 주최자는
 *    이벤트가 내려간 줄 안다. 503(재시도 가능)으로 구분한다.
 *
 * ── 레벨2 컷오버 W5-CONTENT ──
 * go `widget_configs` → v2 `organizer_widget_configs` 이관 완료(공개 read = public-content).
 * 🔴 **fail-closed**: 위젯 설정 조회 실패를 "설정 없음(= 허용 도메인 제한 없음)"으로 폴백하면
 *    **아무 사이트나 위젯을 embed** 할 수 있게 된다. 조회 실패는 503 으로 끊는다.
 *    "행이 실제로 없음"(configured=false)만 기존 동작(제한 없음)으로 취급한다.
 *
 * ── 레벨2 컷오버 W2-PS (적대 감사 F-5, 2026-07-28) ──
 * 🔴 이 라우트만 마지막까지 go `products` 를 **직접 SELECT** 하고 있었다. W2-PS 이후 상품 생성은
 *    v2 카탈로그 단독 write 라 go `products` 에는 새 행이 생기지 않는다(prod 실측: KLPGA 0행)
 *    ⟹ 임베드 위젯은 **상품 0개**로 렌더됐다. 공개 상세에서 이미 한 번 터진 결함의 형제다.
 *    정본을 v2 tier 카탈로그로 옮기고, 필터·잔여 계산은 공개 상세와 **같은 함수**를 쓴다
 *    (`lib/public/tier-view.ts` — 복붙이 갈라진 것이 재발 원인이었다).
 * 🔴 카탈로그 조회 실패도 **빈 목록으로 흘리지 않는다**. "상품 0건"은 화면에서 매진과 구분되지
 *    않으므로 5xx(503, 재시도 가능)로 끊는다.
 */
import { NextResponse, NextRequest } from "next/server";
import {
  getPublicWidgetConfig,
  listTierCatalog,
  V2CommerceError,
  type TierCatalogRow,
} from "@/lib/v2/commerce-client";
import { selectPublicTiers, tierIsOnSale, tierRemainingStock } from "@/lib/public/tier-view";
import { resolveEndsAt } from "@/lib/v2/event-view";
import { PUBLIC_LIVE_STATUSES, resolvePublicEventBySlug } from "@/lib/v2/public-event";

type Params = { slug: string };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// allowed_domains 항목("example.com" 또는 "https://example.com")과 요청 Origin 호스트 비교.
// 서브도메인은 허용(shop.example.com ⊂ example.com).
function isOriginAllowed(origin: string | null, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true; // 미설정 = 제한 없음 (기존 동작 유지)
  if (!origin) return false;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return allowedDomains.some((entry) => {
    const domain = entry.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

export async function GET(request: NextRequest, context: { params: Promise<Params> }) {
  const { slug } = await context.params;

  const resolved = await resolvePublicEventBySlug(slug, PUBLIC_LIVE_STATUSES);
  if (!resolved.ok) {
    return NextResponse.json(
      {
        success: false,
        error: resolved.status === 404 ? "공개된 이벤트를 찾을 수 없습니다" : resolved.error,
      },
      { status: resolved.status, headers: CORS_HEADERS },
    );
  }
  const event = resolved.event;

  // 🔴 fail-closed — 조회 실패는 기본값(제한 없음)으로 폴백하지 않는다.
  //    실패를 "설정 없음"으로 흘리면 화이트리스트가 통째로 무력화되어 임의 사이트 embed 가 열린다.
  let widgetConfig: {
    mode: string;
    theme: Record<string, unknown>;
    allowed_domains: string[];
    is_active: boolean;
  };
  try {
    const cfg = await getPublicWidgetConfig(event.event_id);
    // configured=false = 주최자가 설정한 적 없음 → go 기존 동작(제한 없음) 유지.
    widgetConfig = {
      mode: cfg.mode,
      theme: cfg.theme ?? {},
      allowed_domains: cfg.allowed_domains ?? [],
      is_active: cfg.is_active,
    };
  } catch (err: unknown) {
    if (!(err instanceof V2CommerceError)) throw err;
    const status = err.status === 404 ? 404 : 503;
    return NextResponse.json(
      {
        success: false,
        error:
          status === 404
            ? "공개된 이벤트를 찾을 수 없습니다"
            : "위젯 설정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요",
      },
      { status, headers: CORS_HEADERS },
    );
  }

  // 주최자가 허용 도메인을 설정한 경우 서버에서 강제한다 — 저장만 하고 검증하지 않으면
  // 임의 사이트가 위젯을 embed 할 수 있어 설정이 무의미해진다.
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  const selfHost = request.headers.get("host")?.split(":")[0]?.toLowerCase() ?? "";
  let originHost = "";
  try {
    originHost = origin ? new URL(origin).hostname.toLowerCase() : "";
  } catch {
    originHost = "";
  }
  const isSelf = selfHost !== "" && originHost === selfHost; // 대시보드 미리보기 등 자기 호스트는 항상 허용
  if (!isSelf && !isOriginAllowed(origin, widgetConfig.allowed_domains ?? [])) {
    return NextResponse.json(
      { success: false, error: "허용되지 않은 도메인입니다" },
      { status: 403, headers: CORS_HEADERS },
    );
  }

  // ── 상품 목록: v2 tier 카탈로그가 정본(go `products` SELECT 폐기) ──
  // 도메인 게이트를 통과한 뒤에 조회한다 — 미허용 Origin 때문에 v2 왕복을 태울 이유가 없다.
  // 🔴 실패를 `products: []` 로 흘리지 않는다. 위젯에서 "상품 0개"는 매진과 구분되지 않고,
  //    주최자는 티켓을 정상 등록하고도 원인을 알 수 없다(이 결함의 핵심). 5xx 로 끊는다.
  let tiers: TierCatalogRow[];
  try {
    const catalog = await listTierCatalog(event.event_id);
    tiers = selectPublicTiers(catalog.tiers);
  } catch (err: unknown) {
    if (!(err instanceof V2CommerceError)) throw err;
    return NextResponse.json(
      {
        success: false,
        error: "상품 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요",
      },
      { status: 503, headers: CORS_HEADERS },
    );
  }
  const nowMs = Date.now();

  return NextResponse.json(
    {
      success: true,
      data: {
        event: {
          title: event.title,
          startsAt: event.event_date,
          // go ends_at 대응 = v2 event_date_end(다일 이벤트). 단일일 이벤트는 시작=종료.
          endsAt: resolveEndsAt(event),
          venueName: event.venue,
          heroImageUrl: event.image_url,
        },
        // `stock` = **잔여**(= capacity − sold_count, 무제한 null) — 공개 상세와 같은 규칙이다.
        //  · 종전 go `products.stock` 은 주최자 입력 **원본**이라 판매량이 빠지지 않았다.
        //  · `isOnSale` 도 종전엔 `is_active`(=목록에 들어온 시점에 이미 true) 라 항상 true 였다.
        //    판매창(sale_window) 기준으로 바로잡는다 — 판매 전/종료를 위젯이 구분할 수 있어야 한다.
        products: tiers.map((t) => ({
          id: t.external_ref ?? t.tier_id,
          name: t.name,
          price: Number(t.base_price),
          stock: tierRemainingStock(t),
          isOnSale: tierIsOnSale(t, nowMs),
        })),
        theme: widgetConfig.theme,
        mode: widgetConfig.mode,
        isActive: widgetConfig.is_active,
      },
    },
    { headers: CORS_HEADERS },
  );
}

/**
 * 🥇 1-G 골든 상세 정합 (go 랜딩 == consumer 렌더 동일) — 상세페이지 통합(옵션C)의 안전망.
 *
 * 목적: **같은 이벤트를 두 소스에서 읽어 핵심 필드를 대조**한다. 이 테스트가 먼저 있어야
 * 이후 데이터 이식(Phase 1)이 정보를 누락하지 않았는지 회귀로 검증할 수 있다.
 * (계획: docs/plans/DETAIL-UNIFICATION-AGENT-PLAN.md WI 1-G — "이게 없으면 이후 배리어가 허구".)
 *
 * 두 소스:
 *  - go(SoT=랜딩 원본):  /api/public/events/{slug}?format=v2 (= getPublicEventBySlug)
 *                        + /api/public/events/{slug}/seat-maps (좌석맵 원본 mapData)
 *  - v2(이식 대상):      {V2}/api/v1/events/by-slug/{slug} → id → {V2}/api/v1/events/{id} + /tiers
 *    (v2 Event.slug 은 go write-through 로 미러링됨 — 동일 slug 로 양측 조회 가능)
 *
 * ⚠️ 안전망 특성: **지금은 갭이 있어 일부 필드가 fail 하는 게 정상**이다(= 이식 대상을 드러냄).
 * 각 필드를 pass/fail 로 개별 출력해 **이식 체크리스트** 역할을 한다. 이식이 진행되며 green 으로 전환.
 *
 * 실행 전제(환경):
 *  - go 로컬 서버(BASE_URL, 기본 127.0.0.1:3011) + go DB 에 status='live' 인 대상 이벤트
 *  - v2 backend(V2_INTERNAL_BASE_URL, 기본 http://localhost:8021) 에 동일 slug 이벤트가 write-through 됨
 *  - 대상 slug: GOLDEN_PARITY_SLUG 환경변수(미설정 시 go 공개 목록에서 첫 live 이벤트 자동 선택)
 * 환경 미구성 시 대상 이벤트를 못 찾으면 skip(안전망 구축이 목적이라 CI 를 붉게 만들지 않음).
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

const GO_BASE = process.env.BASE_URL ?? "http://127.0.0.1:3011";
const V2_BASE = (process.env.V2_INTERNAL_BASE_URL ?? "http://localhost:8021").replace(/\/$/, "");
const TARGET_SLUG = process.env.GOLDEN_PARITY_SLUG ?? "";

/** 필드 대조 1건의 결과. */
interface FieldResult {
  /** 대조 필드(한국어 라벨). */
  field: string;
  status: "pass" | "fail" | "gap";
  goValue: unknown;
  v2Value: unknown;
  /** gap = v2 소스에 아직 필드가 없음(=이식 대상). fail = 양측 존재하나 값 불일치. */
  note: string;
}

/** go 공개 랜딩(v2 포맷) 응답. getPublicEventBySlug 를 그대로 반영. */
interface GoEvent {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  description: string | null;
  venueName: string | null;
  venueAddress: string | null;
  startsAt: string;
  endsAt: string;
  seoMetadata: Record<string, unknown> | null;
  organizerName: string | null;
  organizers: Array<{ name: string; role: string }>;
  products: Array<{ id: string; name: string; price: number | string; isOnSale?: boolean }>;
  seat_tiers?: Array<{ id: string; name: string; base_price: number | string; capacity: number | null }>;
  schedules: Array<{ id: string; title: string; startsAt: string }>;
  notices: Array<{ id: string; title: string; type: string }>;
  status?: string;
}

/** go 좌석맵 응답(seat-maps 라우트). */
interface GoSeatMaps {
  maps: Array<{ id: string; name: string; status: string; mapData: unknown }>;
  tiers: Array<{ id: string; name: string; basePrice: number | string }>;
}

/** v2 이벤트 상세(EventDetail 부분). */
interface V2Event {
  id: string;
  slug?: string;
  title: string;
  description: string | null;
  venue: string;
  event_date: string;
  event_date_end?: string | null;
  min_price: number;
  max_price: number | null;
  status: string;
  sales_paused?: boolean;
  seat_map_url?: string | null;
  notice?: string | null;
  seat_tiers?: Array<{ id: string; name: string; base_price: number; capacity: number }>;
  image_variants?: Record<string, string> | null;
  // 아래는 이식 후 나타날 신규 갭 필드(현재 v2 미보유 — 명시)
  summary?: string | null;
  seo_metadata?: Record<string, unknown> | null;
  event_schedules?: Array<{ id: string; title: string; starts_at: string }> | null;
  seat_map_data?: unknown; // 1-Map: 좌석맵 원본 canvas (현재 v2 미보관)
}

/** v2 tier 배열. */
interface V2Tier {
  id: string;
  name: string;
  base_price: number;
  capacity: number;
}

/** 문자열/숫자 금액을 정수(원)로 정규화. */
function toAmount(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** ISO 시각을 초 단위로 비교(밀리초·타임존 표기 차 무시). */
function isoEq(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) < 1000;
}

/** 문자열 정규화(공백 트림·null↔"" 동일 취급). */
function strEq(a: unknown, b: unknown): boolean {
  const na = a == null ? "" : String(a).trim();
  const nb = b == null ? "" : String(b).trim();
  return na === nb;
}

/** go 슬러그로 v2 이벤트 id 를 역참조(by-slug). */
async function resolveV2IdBySlug(req: APIRequestContext, slug: string): Promise<string | null> {
  const res = await req.get(`${V2_BASE}/api/v1/events/by-slug/${encodeURIComponent(slug)}`);
  if (!res.ok()) return null;
  const json = await res.json().catch(() => null);
  const data = json?.data ?? json;
  return typeof data?.id === "string" ? data.id : null;
}

test.describe.serial("🥇 1-G 골든 상세 정합 (go 랜딩 == consumer 렌더)", () => {
  let request: APIRequestContext;
  let slug: string | null = null;
  let go: GoEvent | null = null;
  let goSeatMaps: GoSeatMaps | null = null;
  let v2: V2Event | null = null;
  let v2Tiers: V2Tier[] = [];
  const results: FieldResult[] = [];

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();

    // 1) 대상 slug 확정: 지정 slug 우선, 없으면 go 공개 목록에서 첫 live 이벤트.
    slug = TARGET_SLUG || null;
    if (!slug) {
      const list = await request.get(`${GO_BASE}/api/public/events?limit=20`);
      if (list.ok()) {
        const body = await list.json().catch(() => null);
        const items: Array<{ slug?: string }> = body?.data?.items ?? body?.data ?? [];
        slug = items.find((e) => typeof e.slug === "string")?.slug ?? null;
      }
    }
    if (!slug) return;

    // 2) go 소스 로드(랜딩 원본 + 좌석맵).
    const goRes = await request.get(
      `${GO_BASE}/api/public/events/${encodeURIComponent(slug)}?format=v2`,
    );
    if (goRes.ok()) {
      const body = await goRes.json().catch(() => null);
      go = (body?.data ?? body) as GoEvent;
    }
    const mapsRes = await request.get(
      `${GO_BASE}/api/public/events/${encodeURIComponent(slug)}/seat-maps`,
    );
    if (mapsRes.ok()) {
      const body = await mapsRes.json().catch(() => null);
      goSeatMaps = (body?.data ?? body) as GoSeatMaps;
    }

    // 3) v2 소스 로드(by-slug → detail → tiers).
    const v2Id = await resolveV2IdBySlug(request, slug);
    if (v2Id) {
      const detailRes = await request.get(`${V2_BASE}/api/v1/events/${v2Id}`);
      if (detailRes.ok()) {
        const body = await detailRes.json().catch(() => null);
        v2 = (body?.data ?? body) as V2Event;
      }
      const tiersRes = await request.get(`${V2_BASE}/api/v1/events/${v2Id}/tiers`);
      if (tiersRes.ok()) {
        const body = await tiersRes.json().catch(() => null);
        const arr = Array.isArray(body) ? body : (body?.data ?? []);
        v2Tiers = Array.isArray(arr) ? (arr as V2Tier[]) : [];
      }
    }
  });

  test.afterAll(async () => {
    // 필드별 pass/fail/gap 을 한 표로 출력 — 이식 체크리스트.
    if (results.length > 0) {
      const line = (r: FieldResult) =>
        `  [${r.status === "pass" ? "✅ PASS" : r.status === "gap" ? "🟡 GAP " : "❌ FAIL"}] ${r.field} — ${r.note}`;
      const gaps = results.filter((r) => r.status === "gap");
      const fails = results.filter((r) => r.status === "fail");
      console.log(
        [
          "",
          "═══ 🥇 골든 상세 정합 리포트 (go 랜딩 vs v2 소스) ═══",
          `대상 slug: ${slug ?? "(미확정)"}`,
          ...results.map(line),
          "",
          `요약: PASS ${results.filter((r) => r.status === "pass").length} · GAP(이식대상) ${gaps.length} · FAIL(불일치) ${fails.length}`,
          gaps.length > 0
            ? `이식 대상(v2 미보유): ${gaps.map((r) => r.field).join(", ")}`
            : "이식 대상 없음(모든 필드 v2 보유)",
          "═══════════════════════════════════════════════",
          "",
        ].join("\n"),
      );
    }
    await request.dispose();
  });

  /**
   * 필드 대조 헬퍼. eq=true 면 pass. v2Value 가 undefined/누락이면 gap(=이식 대상),
   * 그 외 불일치는 fail. 결과를 results 에 적재하고 pass 아닐 시 soft-fail(expect.soft)로
   * 다른 필드 대조를 막지 않으면서도 테스트 전체는 실패 처리.
   */
  function assertField(
    field: string,
    goValue: unknown,
    v2Value: unknown,
    eq: boolean,
    opts: { v2Missing?: boolean } = {},
  ) {
    const v2Missing = opts.v2Missing ?? (v2Value === undefined || v2Value === null);
    const status: FieldResult["status"] = eq ? "pass" : v2Missing ? "gap" : "fail";
    const note = eq
      ? "일치"
      : v2Missing
        ? "v2 소스에 필드 없음 → Phase1 이식 대상"
        : `불일치: go=${JSON.stringify(goValue)?.slice(0, 60)} v2=${JSON.stringify(v2Value)?.slice(0, 60)}`;
    results.push({ field, status, goValue, v2Value, note });
    // gap 은 "예상된 현재 갭"이므로 soft 로만 표기(테스트를 붉게 하되 이식 전 노이즈 최소화).
    expect.soft(eq, `${field}: ${note}`).toBeTruthy();
  }

  test("소스 로드 — 두 소스 모두 대상 이벤트를 반환해야(미구성 시 skip)", async () => {
    test.skip(!slug, "대상 slug 미확정(go 공개 live 이벤트 없음·환경 미구성) → skip");
    test.skip(!go, `go 소스 로드 실패(${GO_BASE}) — go 서버/DB 미구성 → skip`);
    test.skip(!v2, `v2 소스 로드 실패(${V2_BASE}) — v2 backend/by-slug 미배선 → skip`);
    expect(go?.slug ?? slug).toBe(slug);
  });

  test("핵심 텍스트 — title · description · summary · venue", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const g = go!;
    const v = v2!;
    assertField("title(제목)", g.title, v.title, strEq(g.title, v.title));
    assertField(
      "description(상세설명)",
      g.description,
      v.description,
      strEq(g.description, v.description),
    );
    // summary 는 v2 신규 갭 필드(계획 1-S) — 현재 미보유면 gap.
    assertField("summary(요약)", g.summary, v.summary, strEq(g.summary, v.summary), {
      v2Missing: v.summary === undefined,
    });
    // go venueName ↔ v2 venue.
    assertField("venue(장소명)", g.venueName, v.venue, strEq(g.venueName, v.venue));
    // venueAddress 는 v2 detail 표면에 없음(venue_id→venues 조인) — gap 후보.
    assertField(
      "venueAddress(주소)",
      g.venueAddress,
      (v as { venue_address?: string }).venue_address,
      strEq(g.venueAddress, (v as { venue_address?: string }).venue_address),
      { v2Missing: (v as { venue_address?: string }).venue_address === undefined },
    );
  });

  test("일시 — event_date(시작) · 종료", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const g = go!;
    const v = v2!;
    assertField("event_date(시작일시)", g.startsAt, v.event_date, isoEq(g.startsAt, v.event_date));
    assertField(
      "event_date_end(종료일시)",
      g.endsAt,
      v.event_date_end,
      isoEq(g.endsAt, v.event_date_end),
      { v2Missing: v.event_date_end == null },
    );
  });

  test("가격 — min/max · 티어 대조", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const g = go!;
    const v = v2!;
    const goPrices = (g.products ?? [])
      .map((p) => toAmount(p.price))
      .filter((n): n is number => n != null);
    const goMin = goPrices.length ? Math.min(...goPrices) : null;
    const goMax = goPrices.length ? Math.max(...goPrices) : null;

    assertField(
      "min_price(최저가)",
      goMin,
      v.min_price,
      goMin != null && toAmount(v.min_price) === goMin,
      { v2Missing: v.min_price == null },
    );
    assertField(
      "max_price(최고가)",
      goMax,
      v.max_price,
      goMax != null && toAmount(v.max_price) === goMax,
      { v2Missing: v.max_price == null },
    );

    // 티어 수·이름·가격 대조. go seat_tiers(공개 랜딩 alias) 또는 products 를 v2 tiers 와 비교.
    const goTiers = (g.seat_tiers ?? g.products ?? []).map((t) => ({
      name: t.name,
      price: toAmount((t as { base_price?: unknown; price?: unknown }).base_price ?? (t as { price?: unknown }).price),
    }));
    const v2TierList = (v2Tiers.length ? v2Tiers : (v.seat_tiers ?? [])).map((t) => ({
      name: t.name,
      price: toAmount(t.base_price),
    }));
    assertField(
      "티어 개수",
      goTiers.length,
      v2TierList.length,
      goTiers.length > 0 && goTiers.length === v2TierList.length,
      { v2Missing: v2TierList.length === 0 },
    );
    // 티어별 (이름·가격) 집합 일치 여부.
    const key = (t: { name: string; price: number | null }) => `${t.name}=${t.price}`;
    const goSet = new Set(goTiers.map(key));
    const v2Set = new Set(v2TierList.map(key));
    const tiersMatch =
      goSet.size === v2Set.size && [...goSet].every((k) => v2Set.has(k));
    assertField(
      "티어 이름·가격 집합",
      [...goSet],
      [...v2Set],
      goTiers.length > 0 && tiersMatch,
      { v2Missing: v2TierList.length === 0 },
    );
  });

  test("일정 — schedules(타임테이블)", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const g = go!;
    const v = v2!;
    const goSch = g.schedules ?? [];
    // v2 event_schedules 는 신규 갭 필드(계획 1-S) — 현재 미보유면 gap.
    const v2Sch = v.event_schedules ?? undefined;
    assertField(
      "schedules 개수",
      goSch.length,
      v2Sch?.length,
      v2Sch != null && goSch.length === v2Sch.length,
      { v2Missing: v2Sch === undefined },
    );
  });

  test("좌석 — seat_tiers · 좌석맵 원본(mapData) 동일 렌더", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const v = v2!;
    const goMaps = goSeatMaps?.maps ?? [];
    const goPublishedMap = goMaps.find((m) => m.status === "published") ?? goMaps[0];
    const goHasMap = !!goPublishedMap && goPublishedMap.mapData != null;

    // 1-Map(census 0-C): v2 는 seat_map_url(URL)만 보유, 원본 canvas(mapData/seat_map_data) 미보관.
    // 좌석지정 이벤트는 이게 없으면 consumer 가 좌석배치도를 원본 렌더 못 함 → 이식 전엔 gap.
    const v2MapData = (v as { seat_map_data?: unknown }).seat_map_data;
    if (goHasMap) {
      assertField(
        "좌석맵 원본(mapData canvas)",
        "present",
        v2MapData,
        v2MapData != null,
        { v2Missing: v2MapData === undefined || v2MapData === null },
      );
    } else {
      // 좌석맵 없는 이벤트(비지정석)는 대조 제외 — pass 로 기록.
      assertField("좌석맵 원본(mapData canvas)", "n/a", "n/a", true, { v2Missing: false });
    }
    // seat_map_url(썸네일 URL) 은 v2 에 존재할 수 있음 — 참고용 대조(있으면 pass).
    assertField(
      "seat_map_url(썸네일)",
      goHasMap ? "expected" : "n/a",
      v.seat_map_url ?? null,
      true, // URL 은 원본과 별개라 정합 실패로 보지 않음(참고 표기)
      { v2Missing: false },
    );
  });

  test("판매상태 — status(투영) · sales_paused", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const v = v2!;
    // go 는 live 투영, v2 는 canonical(approved/bidding_open 등). 매핑 후 "판매가능" 동치 여부만 확인.
    const v2Sellable = !["draft", "cancelled", "archived", "ended"].includes((v.status ?? "").toLowerCase());
    assertField(
      "판매상태(판매가능 동치)",
      "live",
      v.status,
      v2Sellable,
      { v2Missing: v.status == null },
    );
    assertField(
      "sales_paused(일시중지)",
      false,
      v.sales_paused ?? false,
      (v.sales_paused ?? false) === false,
      { v2Missing: false },
    );
  });

  test("공지 — notices(공개 공지)", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const g = go!;
    const v = v2!;
    const goNotices = g.notices ?? [];
    // v2 는 단일 notice(text)만 보유 — go 는 구조화 open_notices[]. 구조 차이 = gap.
    const v2HasNotice = typeof v.notice === "string" && v.notice.trim().length > 0;
    assertField(
      "notices(공개 공지)",
      goNotices.length,
      v.notice ?? undefined,
      goNotices.length === 0 || v2HasNotice,
      { v2Missing: v.notice === undefined },
    );
  });

  test("출연진 — organizers(공동주최자·역할)", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const g = go!;
    const v = v2!;
    const goOrganizers = g.organizers ?? [];
    // v2 detail 은 organizer_name(단일) 표면 — 다자 organizers[] 미보유 시 gap.
    const v2OrgName = (v as { organizer_name?: string | null }).organizer_name;
    const hostName = goOrganizers.find((o) => o.role === "host")?.name ?? g.organizerName;
    assertField(
      "대표 주최자명",
      hostName,
      v2OrgName,
      strEq(hostName, v2OrgName),
      { v2Missing: v2OrgName === undefined },
    );
    // 다자 출연진 배열은 v2 미보유(gap) — 계획상 participants(EventContentInput)로 이식.
    assertField(
      "출연진/공동주최 배열",
      goOrganizers.map((o) => o.name),
      (v as { participants?: unknown }).participants,
      false,
      { v2Missing: (v as { participants?: unknown }).participants === undefined },
    );
  });

  test("SEO/OG 메타 — seo_metadata · og 이미지", async () => {
    test.skip(!go || !v2, "소스 미로드 → skip");
    const g = go!;
    const v = v2!;
    // seo_metadata 는 v2 신규 갭 필드(계획 1-S) — 현재 미보유면 gap.
    const goSeo = g.seoMetadata ?? null;
    const v2Seo = v.seo_metadata;
    const goHasSeo = goSeo != null && Object.keys(goSeo).length > 0;
    assertField(
      "seo_metadata(SEO 메타)",
      goSeo,
      v2Seo,
      !goHasSeo || (v2Seo != null && JSON.stringify(goSeo) === JSON.stringify(v2Seo)),
      { v2Missing: v2Seo === undefined },
    );
    // OG 이미지 렌디션(image_variants.og) 존재 동치 — consumer generateMetadata 가 이걸로 og 만듦.
    const v2HasOg =
      v.image_variants != null &&
      (typeof v.image_variants.og === "string" || Object.keys(v.image_variants).length > 0);
    assertField(
      "og 이미지(image_variants)",
      "expected",
      v.image_variants ?? null,
      v2HasOg,
      { v2Missing: v.image_variants == null },
    );
  });
});

/**
 * 상품·좌석등급 카탈로그 — 레벨2 컷오버 wave2 **W2-PS**.
 *
 * ## 무엇이 바뀌었나
 * go `products` / `seat_tiers` 두 테이블이 사라진다. 둘 다 v2 `seat_tiers` 한 테이블로 흡수되고,
 * **주최자 화면이 쓰던 id 는 v2 `external_ref`** 로 그대로 보존된다(URL·기존 참조 무손실).
 *
 * ## 두 화면이 한 테이블을 공유하는 문제 — `go_source`
 * go 에서 상품(`/products`)과 좌석등급(좌석 빌더의 등급 관리)은 **다른 테이블·다른 화면**이었다.
 * v2 에선 같은 `seat_tiers` 행이므로 구분자가 없으면 서로의 행이 상대 화면에 섞인다.
 * → `tier_metadata.go_source` 에 `"product" | "seat_tier"` 를 기록한다.
 *
 * ⚠️ **레거시 행(메타 미기록)** 은 `"product"` 로 간주한다. 근거: v2 tier 를 만드는 경로는
 *    상품 write-through·RSVP/초대권 0원 상품·resync 등 대부분 상품 계열이고, 좌석등급은
 *    좌석 빌더에서만 생성된다. 컷오버 시 `scripts/backfill-tier-go-source.ts` 로 go
 *    `seat_tiers.id` 들을 `"seat_tier"` 로 표시해야 이 추정이 필요 없어진다(배포 게이트).
 *
 * ## 🔴 재고(stock) 계약 — capacity 를 재고로 읽지 마라
 *  - `stock_limit` = 주최자가 입력한 재고 **원본**. `null` = 무제한, `0` = 재고 없음.
 *  - `capacity`    = v2 집행값. 무제한이면 `1,000,000` sentinel 이 들어 있다.
 * 화면·폼은 반드시 `stock_limit` 을 쓴다. capacity 를 쓰면 무제한 상품이 "재고 100만개"로 보인다.
 *
 * 종전 go 는 `stock <= 0 → 1,000,000` 으로 보내 **재고 0 을 무제한으로 승격**시켰다(초과판매).
 * 이제 0 은 0 으로 집행된다(v2 CHECK `capacity >= 0`, alembic w2ps_0727).
 *
 * ## 실패 취급
 * 이 모듈은 어떤 실패도 흡수하지 않는다. `V2CommerceError`·`EventAccessError` 를 그대로 던지고
 * 라우트가 상태코드를 고른다(미소유/미존재 404 · v2 장애 503). 재고/가격 조회 실패를 빈 목록·0석·
 * 0원으로 뭉개면 매진·무료로 보이기 때문이다.
 */
import { toCanonicalSaleMode } from "@/lib/domain-model";
import {
  V2CommerceError,
  listTierCatalog,
  upsertTierCatalog,
  type TierCatalogRow,
  type TierCatalogUpsertInput,
} from "@/lib/v2/commerce-client";

/** v2 가 무제한 재고를 표현하는 capacity sentinel(정본: internal_commerce.UNLIMITED_TIER_CAPACITY). */
export const UNLIMITED_TIER_CAPACITY = 1_000_000;

/** 카탈로그 행의 출처 화면. `tier_metadata.go_source` 에 보존된다. */
export type TierSource = "product" | "seat_tier";

export interface BundleItemRef {
  productId: string;
  quantity: number;
}

/** go `products` 한 행과 동형(주최자 상품 화면 계약). */
export interface ProductView {
  id: string;
  name: string;
  description: string | null;
  type: string;
  visibility: string;
  price: number;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  stock: number | null;
  minPerOrder: number;
  maxPerOrder: number | null;
  taxIncluded: boolean;
  taxRate: number;
  sortOrder: number;
  imageUrl: string | null;
  isActive: boolean;
  soldCount: number;
  bundleItems: Array<BundleItemRef & { productName: string; price: number }>;
}

/** go `seat_tiers` 한 행과 동형(좌석 빌더 등급 계약, `SeatTier` 타입 호환). */
export interface SeatTierView {
  id: string;
  accountId: string;
  eventId: string;
  seatMapId: string | null;
  productId: string | null;
  name: string;
  capacity: number;
  basePrice: number;
  facePrice: number;
  saleMode: string;
  viewDescription: string | null;
  distanceFromStage: number | null;
  viewRating: number | null;
  viewImageUrl: string | null;
  positionLabel: string | null;
  resaleAllowed: boolean;
  resaleMaxPrice: number;
  allowGroupTickets: boolean;
  maxGroupSize: number;
  colorHex: string | null;
  displayOrder: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** v2 sold_count(환불 제외 판매수 SoT). go `seat_tiers` 에는 없던 보강 필드. */
  soldCount: number;
  fillRate: number;
}

/** 카탈로그 행 + 출처 판정 결과. */
export interface CatalogEntry {
  row: TierCatalogRow;
  /** 주최자 화면이 쓰는 id — external_ref 우선, 없으면 v2 tier_id. */
  ref: string;
  source: TierSource;
}

function metadataOf(row: TierCatalogRow): Record<string, unknown> {
  return (row.tier_metadata ?? {}) as Record<string, unknown>;
}

/**
 * 행의 출처 판정. 레거시(미기록)는 `"product"`(위 모듈 주석의 근거·백필 계획 참조).
 * 빌더 흔적(seat_map_id / color_hex)이 있으면 메타가 없어도 좌석등급으로 본다.
 */
export function classifyTier(row: TierCatalogRow): TierSource {
  const marked = metadataOf(row).go_source;
  if (marked === "seat_tier" || marked === "product") return marked;
  if (row.seat_map_id || row.color_hex) return "seat_tier";
  return "product";
}

function toEntry(row: TierCatalogRow): CatalogEntry {
  return { row, ref: row.external_ref ?? row.tier_id, source: classifyTier(row) };
}

/**
 * 이벤트의 카탈로그 전체를 읽는다.
 *
 * @throws V2CommerceError — 조회 실패. **빈 배열로 흡수하지 않는다**(빈 목록 = 상품 없음으로 보임).
 */
export async function loadCatalog(v2EventId: string): Promise<CatalogEntry[]> {
  const { tiers } = await listTierCatalog(v2EventId);
  return tiers.map(toEntry);
}

/** 카탈로그에서 상품(products 화면) 행만. `sort_order` → 이름 순(go ORDER BY 재현). */
export function selectProducts(entries: CatalogEntry[]): CatalogEntry[] {
  return entries
    .filter((e) => e.source === "product")
    .sort((a, b) =>
      (a.row.sort_order ?? 0) - (b.row.sort_order ?? 0) || a.row.name.localeCompare(b.row.name),
    );
}

/** 카탈로그에서 좌석등급 행만. go `ORDER BY display_order ASC, base_price DESC` 재현. */
export function selectSeatTiers(entries: CatalogEntry[]): CatalogEntry[] {
  return entries
    .filter((e) => e.source === "seat_tier")
    .sort((a, b) =>
      (a.row.sort_order ?? 0) - (b.row.sort_order ?? 0) ||
      (b.row.base_price ?? 0) - (a.row.base_price ?? 0),
    );
}

/** 재고 원본 → v2 집행 capacity. `null`(무제한) → sentinel, 그 외는 그대로(0 포함). */
export function toCapacity(stockLimit: number | null): number {
  return stockLimit === null ? UNLIMITED_TIER_CAPACITY : Math.max(0, Math.trunc(stockLimit));
}

/** v2 행 → go 상품 뷰. 번들 구성품 이름/가격은 같은 이벤트의 다른 행에서 보강한다. */
export function toProductView(entry: CatalogEntry, all: CatalogEntry[]): ProductView {
  const { row } = entry;
  const byRef = new Map(all.map((e) => [e.ref, e.row]));
  const bundleItems = (row.bundle_items ?? []).map((item) => {
    const target = byRef.get(item.productId);
    return {
      productId: item.productId,
      quantity: item.quantity,
      productName: target?.name ?? "",
      price: target ? Number(target.base_price ?? 0) : 0,
    };
  });
  bundleItems.sort((a, b) => a.productName.localeCompare(b.productName));

  return {
    id: entry.ref,
    name: row.name,
    description: row.description ?? null,
    type: row.product_type ?? "ticket",
    visibility: row.visibility ?? "public",
    price: Number(row.base_price ?? 0),
    saleStartsAt: row.sale_window?.opens_at ?? null,
    saleEndsAt: row.sale_window?.closes_at ?? null,
    // 🔴 capacity 가 아니라 stock_limit. capacity 는 무제한 sentinel 을 품고 있다.
    stock: row.stock_limit ?? null,
    minPerOrder: row.min_per_order ?? 1,
    maxPerOrder: row.max_per_order ?? null,
    taxIncluded: row.tax_included ?? true,
    taxRate: row.tax_rate ?? 10,
    sortOrder: row.sort_order ?? 0,
    imageUrl: row.image_url ?? null,
    isActive: row.is_active ?? true,
    soldCount: row.sold_count ?? 0,
    bundleItems,
  };
}

/** v2 행 → go 좌석등급 뷰. */
export function toSeatTierView(
  entry: CatalogEntry,
  accountId: string,
  eventId: string,
): SeatTierView {
  const { row } = entry;
  const meta = metadataOf(row);
  return {
    id: entry.ref,
    accountId,
    eventId,
    seatMapId: row.seat_map_id ?? null,
    productId: typeof meta.product_id === "string" ? meta.product_id : null,
    name: row.name,
    capacity: row.capacity ?? 0,
    basePrice: Number(row.base_price ?? 0),
    facePrice: Number(row.face_price ?? 0),
    saleMode: row.sale_mode ?? "fixed_fcfs",
    viewDescription: row.view_description ?? null,
    distanceFromStage: row.distance_from_stage ?? null,
    viewRating: row.view_rating ?? null,
    viewImageUrl: row.view_image_url ?? null,
    positionLabel: row.position_label ?? null,
    resaleAllowed: row.resale_allowed ?? true,
    resaleMaxPrice: Number(row.resale_max_price ?? 0),
    allowGroupTickets: row.allow_group_tickets ?? true,
    maxGroupSize: row.max_group_size ?? 4,
    colorHex: row.color_hex ?? null,
    displayOrder: row.sort_order ?? 0,
    metadata: meta,
    // v2 tier 는 생성/수정 시각을 노출하지 않는다(계약에 없음). go 화면도 쓰지 않아 빈 문자열.
    createdAt: "",
    updatedAt: "",
    soldCount: row.sold_count ?? 0,
    fillRate: row.fill_rate ?? 0,
  };
}

/** 상품 write 입력(go 폼 → v2 upsert). `undefined` 필드는 v2 에서 **보존**된다. */
export interface ProductWriteInput {
  ref: string;
  name: string;
  description?: string | null;
  type: string;
  price: number;
  /** `null` = 무제한. `0` = 재고 없음(판매불가). */
  stock: number | null;
  minPerOrder: number;
  maxPerOrder: number | null;
  taxIncluded: boolean;
  taxRate: number;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  imageUrl: string | null;
  visibility?: string;
  isActive?: boolean;
  sortOrder?: number;
  bundleItems?: BundleItemRef[];
  saleMode?: string | null;
}

export function toProductUpsert(input: ProductWriteInput): TierCatalogUpsertInput {
  return {
    external_ref: input.ref,
    name: input.name,
    capacity: toCapacity(input.stock),
    stock_limit: input.stock,
    base_price: input.price,
    sale_mode: toCanonicalSaleMode(input.saleMode ?? "fixed_fcfs"),
    // 판매창은 둘 다 있을 때만 전달(단일이면 v2 가 이벤트 판매창을 적용).
    ...(input.saleStartsAt && input.saleEndsAt
      ? { sale_window: { opens_at: input.saleStartsAt, closes_at: input.saleEndsAt } }
      : {}),
    description: input.description ?? null,
    product_type: input.type,
    visibility: input.visibility ?? "public",
    tax_rate: input.taxRate,
    tax_included: input.taxIncluded,
    image_url: input.imageUrl,
    ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
    min_per_order: input.minPerOrder,
    max_per_order: input.maxPerOrder,
    ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    bundle_items: input.bundleItems ?? [],
    tier_metadata: { go_source: "product" satisfies TierSource },
  };
}

/** 좌석등급 write 입력(빌더 → v2 upsert). */
export interface SeatTierWriteInput {
  ref: string;
  name: string;
  capacity: number;
  basePrice: number;
  facePrice?: number | null;
  saleMode?: string | null;
  colorHex?: string | null;
  displayOrder?: number | null;
  seatMapId?: string | null;
  productId?: string | null;
  viewDescription?: string | null;
  distanceFromStage?: number | null;
  viewRating?: number | null;
  viewImageUrl?: string | null;
  positionLabel?: string | null;
  resaleAllowed?: boolean | null;
  resaleMaxPrice?: number | null;
  allowGroupTickets?: boolean | null;
  maxGroupSize?: number | null;
}

export function toSeatTierUpsert(input: SeatTierWriteInput): TierCatalogUpsertInput {
  const meta: Record<string, unknown> = { go_source: "seat_tier" satisfies TierSource };
  if (input.productId != null) meta.product_id = input.productId;
  const out: TierCatalogUpsertInput = {
    external_ref: input.ref,
    name: input.name,
    // 좌석등급 capacity 는 좌석 배치도에서 파생되는 값이라 0(미배정)이 정상 상태다.
    // stock_limit 은 보내지 않는다 — 상품 재고 개념이 아니다(v2 가 capacity 를 그대로 집행).
    capacity: Math.max(0, Math.trunc(input.capacity)),
    base_price: input.basePrice,
    sale_mode: toCanonicalSaleMode(input.saleMode ?? "fixed_fcfs"),
    product_type: "ticket",
    tier_metadata: meta,
  };
  if (input.facePrice != null) out.face_price = input.facePrice;
  if (input.colorHex !== undefined) out.color_hex = input.colorHex;
  if (input.displayOrder != null) out.sort_order = input.displayOrder;
  if (input.seatMapId !== undefined) out.seat_map_id = input.seatMapId;
  if (input.viewDescription !== undefined) out.view_description = input.viewDescription;
  if (input.distanceFromStage !== undefined) out.distance_from_stage = input.distanceFromStage;
  if (input.viewRating !== undefined) out.view_rating = input.viewRating;
  if (input.viewImageUrl !== undefined) out.view_image_url = input.viewImageUrl;
  if (input.positionLabel !== undefined) out.position_label = input.positionLabel;
  if (input.resaleAllowed !== undefined) out.resale_allowed = input.resaleAllowed;
  if (input.resaleMaxPrice !== undefined) out.resale_max_price = input.resaleMaxPrice;
  if (input.allowGroupTickets !== undefined) out.allow_group_tickets = input.allowGroupTickets;
  if (input.maxGroupSize !== undefined) out.max_group_size = input.maxGroupSize;
  return out;
}

/**
 * 번들 구성품 검증 — go `SELECT ... FROM products WHERE account_id/event_id` 의 v2 대체.
 * 입력이 **이미 조회에 성공한 카탈로그**라, 조회 실패가 "구성품 없음(400)"으로 둔갑하지 않는다.
 *
 * @returns 위반 사유(한국어) 또는 `null`(정상).
 */
export function validateBundleItems(
  siblings: CatalogEntry[],
  bundleProductRef: string,
  bundleItems: BundleItemRef[],
): string | null {
  if (bundleItems.length === 0) {
    return "번들 상품은 최소 1개의 구성 상품이 필요합니다";
  }
  const ids = bundleItems.map((item) => item.productId);
  if (ids.length !== new Set(ids).size) {
    return "번들 구성 상품은 중복해서 선택할 수 없습니다";
  }
  if (ids.includes(bundleProductRef)) {
    return "번들 상품에 자기 자신을 포함할 수 없습니다";
  }
  const known = new Set(siblings.map((e) => e.ref));
  return ids.every((id) => known.has(id))
    ? null
    : "같은 이벤트에 속한 상품만 번들에 포함할 수 있습니다";
}

/**
 * 재고 입력 정규화. 무제한 체크 → `null`, 아니면 정수(**0 허용** = 재고 없음/판매불가).
 *
 * ⚠️ 종전 go 는 0 을 무제한(1,000,000)으로 승격시켜 초과판매를 열었다. 0 은 0 이다.
 */
export function parseStockInput(unlimited: boolean, raw: string | undefined): number | null {
  if (unlimited) return null;
  const n = Number(raw ?? "0");
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/**
 * 삭제된 상품 ref 를 다른 상품들의 `bundle_items` 에서 제거한다.
 * go `DELETE FROM product_bundle_items WHERE included_product_id = $1` 의 대체.
 *
 * 영향 받는 행만 부분 upsert 하며, 해당 행의 다른 필드는 **미전달(보존)** 이다.
 * @throws V2CommerceError
 */
export async function upsertBundleItemRemoval(
  v2EventId: string,
  siblings: CatalogEntry[],
  removedRef: string,
): Promise<number> {
  const affected = siblings.filter(
    (e) => e.ref !== removedRef && (e.row.bundle_items ?? []).some((b) => b.productId === removedRef),
  );
  if (affected.length === 0) return 0;
  const payload: TierCatalogUpsertInput[] = affected.map((e) => ({
    external_ref: e.ref,
    name: e.row.name,
    capacity: e.row.capacity,
    base_price: Number(e.row.base_price ?? 0),
    sale_mode: toCanonicalSaleMode(e.row.sale_mode ?? "fixed_fcfs"),
    bundle_items: (e.row.bundle_items ?? []).filter((b) => b.productId !== removedRef),
  }));
  await upsertTierCatalog(v2EventId, payload, {
    idempotencyKey: `bundle-cleanup:${v2EventId}:${removedRef}`,
  });
  return affected.length;
}

/**
 * 카탈로그 1건 upsert. 멱등키는 호출부가 정한다.
 * @throws V2CommerceError
 */
export async function saveCatalogEntry(
  v2EventId: string,
  input: TierCatalogUpsertInput,
  idempotencyKey: string,
): Promise<string> {
  const result = await upsertTierCatalog(v2EventId, [input], { idempotencyKey });
  const tierId = result.tiers[0]?.tier_id;
  if (!tierId) {
    // 응답에 매핑이 없다 = 저장 여부 불명. 성공으로 흡수하지 않는다.
    throw new V2CommerceError("티어 upsert 응답에 tier_id 가 없습니다", 502);
  }
  return tierId;
}

/**
 * 주최자 상품 목록/생성 — 레벨2 컷오버 wave2 **W2-PS**.
 *
 * ## 이전 → 현재
 * 이전엔 go `products`(+ `product_bundle_items`)가 정의를 갖고 v2 `seat_tiers` 는 커머스 미러였다.
 * 이제 **v2 seat_tiers 가 유일 저장소**다. 주최자 화면의 상품 id 는 v2 `external_ref` 로 보존된다
 * (URL·주문 항목 참조 무손실).
 *
 * ## 🔴 실패를 성공으로 위장하지 않는다
 * 종전 GET 은 v2 집계 실패를 `soldCount = 0` 으로 흡수했다. 지금은 상품 정의 자체가 v2 에 있으므로
 * 같은 흡수를 하면 **"상품이 하나도 없다"** 로 보인다 → 조회 실패는 **503**(`catalogErrorResponse`).
 *
 * ## 🔴 재고 계약
 * `stock` 은 v2 `stock_limit`(입력 원본, null=무제한, 0=재고없음)에서 온다. `capacity` 를 쓰면
 * 무제한 상품이 "재고 1,000,000개"로 보인다. 상세는 `lib/v2/tier-catalog.ts` 참조.
 */
import crypto from "node:crypto";

import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { requireOwnedEvent } from "@/lib/v2/event-access";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import {
  loadCatalog,
  parseStockInput,
  saveCatalogEntry,
  selectProducts,
  toProductUpsert,
  toProductView,
  validateBundleItems,
} from "@/lib/v2/tier-catalog";

type Params = { eventId: string };

const productSchema = z.object({
  name: z.string().min(2, "상품명은 2자 이상이어야 합니다"),
  description: z.string().optional(),
  type: z.enum(["ticket", "addon", "bundle", "donation"]),
  price: z.string().optional(),
  isFree: z.boolean(),
  stock: z.string().optional(),
  unlimitedStock: z.boolean(),
  minPerOrder: z.string().min(1, "최소 주문 수량을 입력해주세요"),
  maxPerOrder: z.string().optional(),
  saleStartsAt: z.string().optional(),
  saleEndsAt: z.string().optional(),
  taxIncluded: z.boolean(),
  taxRate: z.string().optional(),
  bundleItems: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().min(1),
    }),
  ).optional(),
  imageUrl: z.string().optional(),
});

function toIso(value: string | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    const items = selectProducts(entries).map((e) => toProductView(e, entries));
    return listResponse(items, items.length);
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, { context: { eventId: params.eventId } });
    if (mapped) return mapped;
    throw err;
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof productSchema>;
  try {
    body = productSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    // 소유 검증 + RSVP 게이트 입력(v2 이벤트가 정본). 미소유 404 / v2 장애 503.
    const event = await requireOwnedEvent(params.eventId, session.accountId);

    // ── 정합 가드(RSVP↔유료 배타) ──
    // RSVP(무료 참석) 이벤트에는 유료 티켓을 추가할 수 없다. 랜딩이 RSVP 폼과 티켓 판매를
    // 배타 렌더하므로 유료 상품이 섞이면 판매 불가한 유령 상품이 된다.
    // ⚠️ `rsvp_enabled` 를 못 읽는 상황은 위 requireOwnedEvent 가 이미 503 으로 끊었다 —
    //    "모르면 통과"로 열어주지 않는다.
    if (body.type === "ticket" && !body.isFree && event.rsvp_enabled) {
      return errorResponse(
        "RSVP(무료 참석) 이벤트에는 유료 티켓을 추가할 수 없습니다. 유료 판매로 전환하려면 이벤트 설정에서 행사 유형을 변경하세요.",
        409,
      );
    }

    const entries = await loadCatalog(event.event_id);
    const products = selectProducts(entries);

    // go 는 상품 id 를 DB 가 발급했다(gen_random_uuid). 이제 앱이 발급해 external_ref 로 쓴다
    // — 좌석맵 mapId 와 같은 방식이며, 재시도 시 새 id 가 생기지 않도록 멱등키를 id 로 고정한다.
    const productId = crypto.randomUUID();
    const bundleItems = body.bundleItems ?? [];
    if (body.type === "bundle") {
      const invalid = validateBundleItems(products, productId, bundleItems);
      if (invalid) return errorResponse(invalid, 400);
    }

    const sortOrder = products.reduce((max, e) => Math.max(max, e.row.sort_order ?? 0), -1) + 1;

    await saveCatalogEntry(
      event.event_id,
      toProductUpsert({
        ref: productId,
        name: body.name,
        description: body.description ?? null,
        type: body.type,
        price: body.isFree ? 0 : Number(body.price ?? "0"),
        stock: parseStockInput(body.unlimitedStock, body.stock),
        minPerOrder: Number(body.minPerOrder),
        maxPerOrder: body.maxPerOrder ? Number(body.maxPerOrder) : null,
        taxIncluded: body.taxIncluded,
        taxRate: body.taxRate ? Number(body.taxRate) : 10,
        saleStartsAt: toIso(body.saleStartsAt),
        saleEndsAt: toIso(body.saleEndsAt),
        imageUrl: body.imageUrl ?? null,
        isActive: true,
        sortOrder,
        bundleItems: body.type === "bundle" ? bundleItems : [],
      }),
      `product-tier:${productId}`,
    );

    return successResponse({ id: productId }, 201);
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      unavailableMessage: "상품 생성 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId: params.eventId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});

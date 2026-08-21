/**
 * 주최자 상품 단건 조회/수정/삭제 — 레벨2 컷오버 wave2 **W2-PS**.
 *
 * go `products` / `product_bundle_items` 접근을 제거하고 v2 `seat_tiers`(카탈로그) 단일 저장소로
 * 전환했다. 상품 id = v2 `external_ref`(URL 보존).
 *
 * ## 🔴 잃으면 안 되는 게이트 2개
 * 1. **판매중 가격변경 차단** — 활성 판매 단계(open/allocating)에서 가격을 바꾸면 표시가·결제액·
 *    집계가 갈라진다. 판매중 여부 **조회 실패 시에도 차단**(보수적 폴백)한다. 열어주면 안 된다.
 * 2. **판매분 있는 상품 삭제 차단** — `sold_count > 0` 이면 409. 확인 불가(v2 장애)면 삭제하지 않고
 *    503. "조회 실패 → 없음 → 삭제 성공"으로 흡수하면 **지우지 않은 것을 지웠다고 답한다**.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { deleteTier, V2CommerceError } from "@/lib/v2/commerce-client";
import { requireOwnedEvent } from "@/lib/v2/event-access";
import { hasActiveSalePhase } from "@/lib/v2/phase-client";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import {
  loadCatalog,
  parseStockInput,
  saveCatalogEntry,
  selectProducts,
  toProductUpsert,
  toProductView,
  upsertBundleItemRemoval,
  validateBundleItems,
} from "@/lib/v2/tier-catalog";

type Params = { eventId: string; productId: string };

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
  imageUrl: z.string().optional(),
  bundleItems: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().min(1),
    }),
  ).optional(),
});

function toIso(value: string | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    const target = selectProducts(entries).find((e) => e.ref === params.productId);
    if (!target) return errorResponse(ERR.NOT_FOUND, 404);
    return successResponse(toProductView(target, entries));
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: ERR.NOT_FOUND,
      context: { eventId: params.eventId, productId: params.productId },
    });
    if (mapped) return mapped;
    throw err;
  }
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
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
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    const products = selectProducts(entries);
    const current = products.find((e) => e.ref === params.productId);
    if (!current) return errorResponse(ERR.NOT_FOUND, 404);

    // ── 게이트 1: 활성 판매 단계 중 가격 변경 차단 ──
    // 비가격 필드(설명/이미지) 수정은 허용해야 하므로 **가격이 실제로 바뀔 때만** 검사한다.
    // 판매 단계 SSOT 는 v2 phase_configs. 조회 실패 시 hasActiveSalePhase 가 throw →
    // 아래 catch 가 502 로 **거부**한다(판매중인지 모른 채 가격을 바꾸는 것보다 안전).
    const newPrice = body.isFree ? 0 : Number(body.price ?? "0");
    if (Number(current.row.base_price ?? 0) !== newPrice) {
      let active: boolean;
      try {
        active = await hasActiveSalePhase(params.eventId, session.accountId);
      } catch (err: unknown) {
        logger.warn("판매 단계 확인 실패로 상품 가격 변경 거부", {
          eventId: params.eventId,
          productId: params.productId,
          error: err instanceof Error ? err.message : String(err),
        });
        return errorResponse("판매 단계 확인에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      if (active) {
        return errorResponse(
          "판매가 진행 중인 단계가 있어 가격을 변경할 수 없습니다. 판매 단계 종료 후 변경해주세요.",
          409,
        );
      }
    }

    const bundleItems = body.bundleItems ?? [];
    if (body.type === "bundle") {
      const invalid = validateBundleItems(products, params.productId, bundleItems);
      if (invalid) return errorResponse(invalid, 400);
    }

    await saveCatalogEntry(
      event.event_id,
      toProductUpsert({
        ref: params.productId,
        name: body.name,
        description: body.description ?? null,
        type: body.type,
        price: newPrice,
        stock: parseStockInput(body.unlimitedStock, body.stock),
        minPerOrder: Number(body.minPerOrder),
        maxPerOrder: body.maxPerOrder ? Number(body.maxPerOrder) : null,
        taxIncluded: body.taxIncluded,
        taxRate: body.taxRate ? Number(body.taxRate) : 10,
        saleStartsAt: toIso(body.saleStartsAt),
        saleEndsAt: toIso(body.saleEndsAt),
        imageUrl: body.imageUrl ?? null,
        visibility: current.row.visibility ?? "public",
        sortOrder: current.row.sort_order ?? 0,
        // go 는 PATCH 마다 product_bundle_items 를 전량 재작성했다(번들이 아니면 비움) — 동일 유지.
        bundleItems: body.type === "bundle" ? bundleItems : [],
      }),
      `product-tier:${params.productId}`,
    );

    return successResponse({ id: params.productId });
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: ERR.NOT_FOUND,
      unavailableMessage: "상품 수정 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
      conflictMessage: "판매된 수량보다 적은 재고로는 변경할 수 없습니다. 재고를 다시 확인해주세요.",
      context: { eventId: params.eventId, productId: params.productId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    const products = selectProducts(entries);
    const target = products.find((e) => e.ref === params.productId);
    // 🔴 여기 도달했다는 건 카탈로그 조회가 **성공**했다는 뜻이다(실패는 catch 에서 503).
    //    따라서 "없음"은 진짜 없음이며 404 로 답해도 안전하다.
    if (!target) return errorResponse(ERR.NOT_FOUND, 404);

    // 게이트 2 — 판매 이력(v2 sold_count = 환불 제외 SoT). 확인 불가는 catch 가 503 으로 끊는다.
    if ((target.row.sold_count ?? 0) > 0) {
      return errorResponse("판매된 주문이 있는 상품은 삭제할 수 없습니다", 409);
    }

    await deleteTier(event.event_id, params.productId, {
      idempotencyKey: `product-delete:${params.productId}`,
    });

    // 다른 상품의 번들 구성에서 이 상품을 제거(go `DELETE ... WHERE included_product_id = $1` 대체).
    // 삭제 자체는 이미 확정됐으므로 실패해도 되돌리지 않는다 — 다음 상품 저장에서 수렴한다.
    try {
      await upsertBundleItemRemoval(event.event_id, products, params.productId);
    } catch (err: unknown) {
      if (!(err instanceof V2CommerceError)) throw err;
      logger.warn("상품 삭제 후 번들 구성 정리 실패(다음 저장에서 수렴)", {
        eventId: params.eventId,
        productId: params.productId,
      });
    }

    return successResponse({ deleted: true });
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: ERR.NOT_FOUND,
      unavailableMessage: "상품 삭제에 실패했습니다. 잠시 후 다시 시도해주세요.",
      conflictMessage: "판매되었거나 좌석이 배정된 상품은 삭제할 수 없습니다",
      context: { eventId: params.eventId, productId: params.productId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});

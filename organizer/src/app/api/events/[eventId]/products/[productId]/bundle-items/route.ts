/**
 * 번들 구성 조회·저장 — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * ## 이원화 해소
 * 번들 구성은 W2-PS 이후 **v2 `seat_tiers.bundle_items` JSONB 에 이미 저장되고 있었다**
 * (상품 생성/수정 라우트가 그리로 쓴다). 그런데 이 라우트만 go `product_bundle_items`
 * 테이블을 계속 읽고 썼다 — 같은 사실이 두 곳에 따로 적히는 **데이터 이원화** 상태였고,
 * 두 값이 다르면 상품 화면과 이 API 가 서로 다른 구성을 보여줬다.
 * go 테이블을 버리고 v2 JSONB 단일화한다.
 *
 * ## 실패 취급
 * 옛 코드는 `catch (error) { return errorResponse(..., 400) }` 로 **모든 실패를 400 입력오류**로
 * 뭉갰다. v2 장애도, 소유권 문제도 전부 "번들 구성을 저장하지 못했습니다(400)" 였다.
 *   - 미소유/미존재 → 404 · v2 장애 → 503 · 검증 위반 → 400 으로 분리한다.
 */
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { toCanonicalSaleMode } from "@/lib/domain-model";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import { requireOwnedEvent } from "@/lib/v2/event-access";
import {
  loadCatalog,
  saveCatalogEntry,
  selectProducts,
  validateBundleItems,
} from "@/lib/v2/tier-catalog";

type Params = { eventId: string; productId: string };

const schema = z.object({
  items: z.array(
    z.object({
      includedProductId: z.string().uuid(),
      quantity: z.number().int().min(1),
    }),
  ),
});

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    const products = selectProducts(entries);
    const target = products.find((e) => e.ref === params.productId);
    // 여기 도달 = 카탈로그 조회 성공(실패는 catch → 503). 따라서 "없음"은 진짜 없음.
    if (!target) return errorResponse("상품을 찾을 수 없습니다", 404);

    const byRef = new Map(products.map((e) => [e.ref, e.row]));
    const rows = (target.row.bundle_items ?? [])
      .map((item) => ({
        // go `product_bundle_items.id` 는 사라졌다. 목록 key 용 합성 id(부모:자식) —
        // 이 조합이 곧 UNIQUE(bundle_product_id, included_product_id) 였다.
        id: `${params.productId}:${item.productId}`,
        includedProductId: item.productId,
        includedProductName: byRef.get(item.productId)?.name ?? "",
        quantity: item.quantity,
      }))
      .sort((a, b) => a.includedProductName.localeCompare(b.includedProductName));

    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "상품을 찾을 수 없습니다",
      unavailableMessage: "번들 구성을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId: params.eventId, productId: params.productId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});

export const PUT = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
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
    if (!current) return errorResponse("상품을 찾을 수 없습니다", 404);

    const items = body.items.map((i) => ({
      productId: i.includedProductId,
      quantity: i.quantity,
    }));
    // 빈 배열 = 구성 비우기(go 의 "DELETE 후 0건 INSERT" 와 동일). 그 경우만 검증을 건너뛴다 —
    // validateBundleItems 는 "번들 상품은 최소 1개" 를 요구하므로 비우기를 막아버린다.
    if (items.length > 0) {
      const invalid = validateBundleItems(products, params.productId, items);
      if (invalid) return errorResponse(invalid, 400);
    }

    // 🔴 부분 upsert — 바꿀 것은 bundle_items 뿐이다. 다른 필드(재고·판매창·메타)는 키를
    //   보내지 않아 v2 가 보존한다. name/capacity/base_price/sale_mode 는 upsert 필수 필드라
    //   **현재 값을 그대로 재전송**한다(값 변경 아님).
    await saveCatalogEntry(
      event.event_id,
      {
        external_ref: params.productId,
        name: current.row.name,
        capacity: current.row.capacity,
        base_price: Number(current.row.base_price ?? 0),
        sale_mode: toCanonicalSaleMode(current.row.sale_mode ?? "fixed_fcfs"),
        bundle_items: items,
      },
      `bundle-items:${params.productId}:${items.map((i) => `${i.productId}x${i.quantity}`).sort().join(",")}`,
    );

    return successResponse({ updated: true });
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "상품을 찾을 수 없습니다",
      unavailableMessage: "번들 구성을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId: params.eventId, productId: params.productId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});

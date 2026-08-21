/**
 * 대기열 목록/신청 — 레벨2 컷오버 wave2 **W2-PS**.
 *
 * 항목 자체는 이미 v2 정본(`waitlist_entries`)이었고, 여기 남아 있던 마지막 go read 2개
 * (상품명 보강 `SELECT ... FROM products`, 상품 소유권 `events JOIN products`)를 v2 카탈로그로 옮겼다.
 *
 * ## 🔴 상품 소유권 게이트를 잃지 마라
 * POST 는 **비인증 공개 경로**다(구매자가 대기 신청). `productId` 는 사용자 입력이라
 * 타 테넌트 상품 UUID 로 오염될 수 있다 → "그 이벤트에 실제로 속한 상품"인지 반드시 확인한다.
 * 확인할 수 없으면(v2 장애) **통과시키지 않고 503** 이다 — 열어주면 크로스테넌트 신청이 생긴다.
 */
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getEvent, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, requireOwnedEvent } from "@/lib/v2/event-access";
import { createWaitlistEntry, listWaitlistEntries } from "@/lib/v2/waitlist-client";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import { loadCatalog } from "@/lib/v2/tier-catalog";
import { isPubliclyVisibleTier } from "@/lib/public/tier-view";

type Params = { eventId: string };

const schema = z.object({
  name: z.string().min(2),
  email: z.email(),
  phone: z.string().optional(),
  productId: z.string().uuid(),
});

/**
 * 대기열 목록 — v2 정본(SSOT). 상품명 보강도 v2 카탈로그에서 배치 조회한다(go `products` 폐기).
 */
export const GET = withRole<Params>("organizer", async (request, { session, params }) => {
  const status = new URL(request.url).searchParams.get("status");
  try {
    // 소유 검증(테넌트 경계) + 카탈로그를 함께 확보. 미소유 404 / v2 장애 503.
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const [result, catalog] = await Promise.all([
      listWaitlistEntries({
        account_id: session.accountId,
        event_id: params.eventId,
        status: status ?? undefined,
      }),
      loadCatalog(event.event_id),
    ]);

    const nameByRef = new Map(catalog.map((e) => [e.ref, e.row.name]));
    const rows = result.items.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      phone: e.phone,
      status: e.status,
      offeredAt: e.offered_at,
      expiresAt: e.expires_at,
      createdAt: e.created_at,
      productName: nameByRef.get(e.product_id) ?? null,
    }));
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      unavailableMessage: "대기열을 불러오지 못했습니다",
      context: { eventId: params.eventId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});

/**
 * 대기열 신청 생성(공개 경로) — 상품 소유권을 v2 카탈로그로 검증한 뒤 v2 정본에 저장한다.
 *
 * 계정 식별: v2 이벤트의 `go_account_id`(테넌트). 세션이 없으므로 이벤트에서 유도한다.
 */
export async function POST(request: Request, context: { params: Promise<Params> }) {
  const { eventId } = await context.params;
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
    // 공개 경로라 organizer_ref 를 강제할 세션이 없다 → 이벤트에서 소유 테넌트를 유도한다.
    const event = await getEvent(eventId);
    const accountId = event.go_account_id ?? null;
    if (!accountId) {
      // 테넌트를 특정할 수 없으면 저장하지 않는다(account 경계 없는 행 생성 금지).
      logger.warn("대기열 신청: 이벤트에 go_account_id 없음", { eventId });
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    // 🔴 상품 소유권 게이트 — productId 가 **이 이벤트**의 상품이어야 한다.
    //    조회 실패는 아래 catch 에서 503(통과 아님).
    //    🔴 그리고 **공개 노출 대상인지**까지 본다 (2026-08-01). 종전엔 "이 이벤트 상품인가"
    //       만 봐서, 숨김 티어(초대권 = 0원·정원 100만)로도 대기 신청이 성립했다.
    //       `checkout/initiate` 와 **같은 판정**을 쓴다 — 규칙을 두 곳에 적으면 갈라진다.
    const catalog = await loadCatalog(event.event_id);
    const entryForProduct = catalog.find((e) => e.ref === body.productId);
    if (!entryForProduct || !isPubliclyVisibleTier(entryForProduct.row)) {
      return errorResponse(ERR.NOT_FOUND, 404);
    }

    // v2 정본에 저장. UNIQUE(event_id, product_id, email) 위반 → v2 409 → 사용자 문구.
    const entry = await createWaitlistEntry({
      account_id: accountId,
      event_id: eventId,
      product_id: body.productId,
      name: body.name,
      email: body.email,
      phone: body.phone ?? null,
    });
    return successResponse({ id: entry.id }, 201);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return err.reason === "not_found"
        ? errorResponse(ERR.NOT_FOUND, 404)
        : errorResponse("대기열 신청에 실패했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      if (err.status === 409) {
        return errorResponse("이미 등록된 대기열 신청입니다", 409);
      }
      logger.warn("대기열 신청 v2 실패", { status: err.status });
      return errorResponse("대기열 신청에 실패했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

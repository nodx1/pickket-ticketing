/**
 * 좌석 등급 단건 조회/수정/삭제 — 레벨2 컷오버 wave2 **W2-PS**.
 *
 * go `seat_tiers` 접근을 제거하고 v2 `seat_tiers`(카탈로그) 단일 저장소로 전환했다.
 * 등급 id = v2 `external_ref`(좌석 배치도의 `tierId` 참조가 이 값이라 반드시 보존).
 *
 * ## 🔴 DELETE 는 멱등 흡수 금지
 * 종전 go 는 `DELETE ... RETURNING` 결과가 0행이면 404 였다. v2 전환 후 "조회 실패 → 없음 →
 * 200 deleted" 로 흐르면 **지우지 않은 등급을 지웠다고 답한다** — 조회/삭제 실패는 503 으로 끊는다.
 * 판매분(sold>0)·좌석이 붙은 등급은 v2 가 409 로 막는다(오삭제로 재고·결제 정합이 깨지는 것 방지).
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { deleteTier } from "@/lib/v2/commerce-client";
import { requireOwnedEvent } from "@/lib/v2/event-access";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import {
  loadCatalog,
  saveCatalogEntry,
  selectSeatTiers,
  toSeatTierUpsert,
  toSeatTierView,
} from "@/lib/v2/tier-catalog";

type Params = { eventId: string; tierId: string };

const NOT_FOUND_MESSAGE = "좌석 티어를 찾을 수 없습니다";
const UNAVAILABLE_MESSAGE = "좌석 등급 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";

/**
 * viewImageUrl SSRF 방지 — HTTPS 전용, 내부 IP 차단.
 */
function validateImageUrl(url: string): { valid: boolean; error?: string } {
  if (!url) return { valid: true };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return { valid: false, error: "https:// 만 허용됩니다" };
    }
    const host = parsed.hostname;
    const blockedPatterns = [
      /^127\./,
      /^10\./,
      /^192\.168\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/,
      /^fe80:/,
    ];
    if (host === "localhost" || blockedPatterns.some((p) => p.test(host))) {
      return { valid: false, error: "내부 IP는 허용되지 않습니다" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "올바른 URL이 아닙니다" };
  }
}

const patchSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    capacity: z.number().int().min(0).max(100_000).optional(),
    basePrice: z.number().int().min(0).optional(),
    facePrice: z.number().int().min(0).optional(),
    saleMode: z
      .enum(["membership_presale", "lottery", "queue_sale", "fcfs_residual"])
      .optional(),
    viewDescription: z.string().max(500).optional(),
    distanceFromStage: z.number().int().min(0).max(500).optional(),
    viewRating: z.number().int().min(1).max(5).optional(),
    viewImageUrl: z.string().url().optional(),
    positionLabel: z.string().max(50).optional(),
    resaleAllowed: z.boolean().optional(),
    resaleMaxPrice: z.number().int().min(0).optional(),
    allowGroupTickets: z.boolean().optional(),
    maxGroupSize: z.number().int().min(1).max(50).optional(),
    colorHex: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, "색상은 #RRGGBB 형식이어야 합니다")
      .optional(),
    displayOrder: z.number().int().min(0).max(999).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "수정할 필드를 하나 이상 지정해주세요",
  });

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    const target = selectSeatTiers(entries).find((e) => e.ref === params.tierId);
    if (!target) return errorResponse(NOT_FOUND_MESSAGE, 404);
    return successResponse(toSeatTierView(target, session.accountId, params.eventId));
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: NOT_FOUND_MESSAGE,
      unavailableMessage: UNAVAILABLE_MESSAGE,
      context: { eventId: params.eventId, tierId: params.tierId },
    });
    if (mapped) return mapped;
    throw err;
  }
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("입력값을 확인해주세요", 400);
  }
  if (body.viewImageUrl !== undefined) {
    const check = validateImageUrl(body.viewImageUrl);
    if (!check.valid) {
      return errorResponse(check.error ?? "올바른 URL이 아닙니다", 400);
    }
  }

  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    const current = selectSeatTiers(entries).find((e) => e.ref === params.tierId);
    if (!current) return errorResponse(NOT_FOUND_MESSAGE, 404);
    const view = toSeatTierView(current, session.accountId, params.eventId);

    // 부분 수정 — 미지정 필드는 기존 값을 그대로 다시 보낸다(v2 는 전량 upsert 계약).
    // 종전 PATCH 가 `capacity > 0 ? capacity : 1` 로 보정하던 워크어라운드는 제거했다:
    // v2 가 capacity 0 을 받게 됐으므로(w2ps_0727) **정원 0 을 1 로 부풀리지 않는다**.
    await saveCatalogEntry(
      event.event_id,
      toSeatTierUpsert({
        ref: params.tierId,
        name: body.name ?? view.name,
        capacity: body.capacity ?? view.capacity,
        basePrice: body.basePrice ?? view.basePrice,
        facePrice: body.facePrice ?? view.facePrice,
        saleMode: body.saleMode ?? view.saleMode,
        colorHex: body.colorHex ?? view.colorHex,
        displayOrder: body.displayOrder ?? view.displayOrder,
        seatMapId: view.seatMapId,
        productId: view.productId,
        viewDescription: body.viewDescription ?? view.viewDescription,
        distanceFromStage: body.distanceFromStage ?? view.distanceFromStage,
        viewRating: body.viewRating ?? view.viewRating,
        viewImageUrl: body.viewImageUrl ?? view.viewImageUrl,
        positionLabel: body.positionLabel ?? view.positionLabel,
        resaleAllowed: body.resaleAllowed ?? view.resaleAllowed,
        resaleMaxPrice: body.resaleMaxPrice ?? view.resaleMaxPrice,
        allowGroupTickets: body.allowGroupTickets ?? view.allowGroupTickets,
        maxGroupSize: body.maxGroupSize ?? view.maxGroupSize,
      }),
      // fresh 멱등키 — 캐시된 응답 재사용 금지(min/max 재계산·캐시무효화 보장).
      `seat-tier-update:${params.tierId}:${Date.now()}`,
    );

    const after = await loadCatalog(event.event_id);
    const updated = selectSeatTiers(after).find((e) => e.ref === params.tierId);
    return successResponse(
      updated ? toSeatTierView(updated, session.accountId, params.eventId) : view,
    );
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: NOT_FOUND_MESSAGE,
      unavailableMessage:
        "좌석 등급 수정의 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
      conflictMessage: "판매된 수량보다 적은 정원으로는 변경할 수 없습니다",
      context: { eventId: params.eventId, tierId: params.tierId },
    });
    if (mapped) return mapped;
    return errorResponse("좌석 티어를 수정하지 못했습니다", 400);
  }
});

export const DELETE = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    // 조회에 **성공**한 상태에서만 여기 도달한다 → "없음"은 진짜 없음(404 안전).
    const target = selectSeatTiers(entries).find((e) => e.ref === params.tierId);
    if (!target) return errorResponse(NOT_FOUND_MESSAGE, 404);

    // 판매분 보호는 v2 가 409 로 강제하지만, 사용자 문구를 정확히 주기 위해 선판정한다.
    if ((target.row.sold_count ?? 0) > 0) {
      return errorResponse("판매된 티켓이 있는 등급은 삭제할 수 없습니다", 409);
    }

    await deleteTier(event.event_id, params.tierId, {
      idempotencyKey: `seat-tier-delete:${params.tierId}`,
    });
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: NOT_FOUND_MESSAGE,
      unavailableMessage: "좌석 등급 삭제에 실패했습니다. 잠시 후 다시 시도해주세요.",
      conflictMessage: "판매되었거나 좌석이 배정된 등급은 삭제할 수 없습니다",
      context: { eventId: params.eventId, tierId: params.tierId },
    });
    if (mapped) return mapped;
    return errorResponse("좌석 티어를 삭제하지 못했습니다", 400);
  }
});

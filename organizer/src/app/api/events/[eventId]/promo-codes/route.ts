/**
 * 프로모코드 목록·생성 — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * ## 무엇이 바뀌었나
 * go `promo_codes` 테이블이 사라진다. 프로모코드의 정본은 v2 `discount_codes` 한 곳이고,
 * 주최자 화면이 쓰는 `id` 는 **v2 canonical discount_code_id** 다(옛 go 앵커 id 폐기).
 *
 * 옛 구조는 go 앵커 + v2 write-through 이중 원장이었고, 그 때문에
 *   - `used_count` 는 go 에서 영원히 0 이라 v2 promo 리포트로 **덮어쓰는 오버레이**가 필요했고,
 *   - 그 오버레이 실패를 조용히 삼켜(0/N 표시) 한도 소진을 못 보게 만들었다.
 * 이제 목록 한 번으로 사용량까지 정본을 읽으므로 오버레이 자체가 없다.
 *
 * ## 실패 취급 (🔴 돈)
 * 프로모코드는 결제 금액에 직결된다. v2 장애를 "빈 목록"으로 위장하면 주최자는 코드가
 * 지워진 줄 알고 다시 만들고, 그 사이 소비자에게는 옛 코드가 계속 먹는다.
 *   - 미소유/미존재 → 404
 *   - v2 장애      → 503 (빈 배열 폴백 금지)
 */
import { z } from "zod";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  V2CommerceError,
  createPromoCode,
  listPromoCodes,
  type PromoCodeRow,
} from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus, resolveOwnedV2EventId } from "@/lib/v2/event-access";

type Params = { eventId: string };

const schema = z.object({
  code: z.string().min(2),
  promoType: z.enum(["fixed", "percentage"]),
  discountValue: z.number().nonnegative(),
  usageLimit: z.number().int().positive().nullable(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
});

/** v2 행 → 주최자 화면 계약(go `promo_codes` SELECT 컬럼과 동형). */
function toPromoView(row: PromoCodeRow) {
  return {
    id: row.promo_id,
    code: row.code,
    promoType: row.promo_type,
    discountValue: row.discount_value,
    usageLimit: row.usage_limit,
    usedCount: row.used_count,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isActive: row.is_active,
  };
}

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      return errorResponse("이벤트를 찾을 수 없습니다.", 404);
    }
    const { promo_codes } = await listPromoCodes(v2EventId);
    const rows = promo_codes.map(toPromoView);
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(
        err.reason === "not_found"
          ? "이벤트를 찾을 수 없습니다."
          : "커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
        eventAccessStatus(err),
      );
    }
    if (err instanceof V2CommerceError) {
      // 🔴 빈 배열로 흡수하지 않는다 — "프로모코드 없음"으로 보이면 중복 생성·과할인이 난다.
      return errorResponse("프로모코드를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());
    if (body.promoType === "percentage" && (body.discountValue < 1 || body.discountValue > 100)) {
      return errorResponse("정률 할인은 1~100 사이여야 합니다", 400);
    }

    const v2EventId = await resolveOwnedV2EventId(params.eventId, session.accountId);
    if (!v2EventId) {
      return errorResponse("이벤트를 찾을 수 없습니다.", 404);
    }

    const created = await createPromoCode(
      v2EventId,
      {
        code: body.code.toUpperCase(),
        promo_type: body.promoType,
        discount_value: body.discountValue,
        usage_limit: body.usageLimit,
        starts_at: body.startsAt ? toIsoFromKstLocal(body.startsAt) : null,
        ends_at: body.endsAt ? toIsoFromKstLocal(body.endsAt) : null,
        is_active: true,
      },
      // 코드 문자열이 곧 이벤트 내 유일키다. 같은 코드 재전송(더블클릭·네트워크 재시도)이
      // 새 행을 만들지 않도록 멱등키를 값에 결속한다. 진짜 중복은 v2 UNIQUE 가 409 로 막는다.
      { idempotencyKey: `promo-create:${v2EventId}:${body.code.toUpperCase()}` },
    );

    return successResponse({ id: created.promo_id }, 201);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    if (err instanceof EventAccessError) {
      return errorResponse(
        err.reason === "not_found"
          ? "이벤트를 찾을 수 없습니다."
          : "커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
        eventAccessStatus(err),
      );
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 409) return errorResponse("이미 사용 중인 프로모코드입니다", 409);
      if (err.status === 400) return errorResponse("프로모코드 입력값을 확인해주세요", 400);
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다.", 404);
      // 그 외(5xx/타임아웃)는 저장 여부 불명 — 성공으로 흡수하지 않는다.
      return errorResponse(
        "프로모코드 생성 중 커머스 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

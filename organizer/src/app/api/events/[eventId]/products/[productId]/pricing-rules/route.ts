/**
 * 동적 가격 규칙 — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * go `pricing_rules`(+ 소유 검증용 `products` JOIN)를 v2 `tier_pricing_rules` 로 옮겼다.
 * 상품 = v2 티어(external_ref = go productId) 이므로 규칙도 티어 스코프다.
 *
 * ## 실패 취급
 * 옛 코드는 모든 실패를 `errorResponse(err.message, 500)` 으로 뭉개면서 **v2/DB 내부 메시지를
 * 그대로 사용자에게 노출**했다. 미소유/미존재 404 · v2 장애 503 · 검증 400 으로 분리하고,
 * 문구는 go 가 고른다.
 *
 * ⚠️ 규칙을 저장해도 가격이 자동으로 바뀌지는 않는다 — 집행 엔진은 go 에도 없었고 v2 에도
 *    아직 없다(보관·조회 계약만 이관). 이 사실은 v2 모델 주석에도 명시돼 있다.
 */
import { z } from "zod";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { ERR } from "@/lib/errors";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import { createPricingRule, listPricingRules } from "@/lib/v2/commerce-client";
import { requireOwnedEvent } from "@/lib/v2/event-access";

const createSchema = z.object({
  ruleType: z.enum(["demand", "time", "inventory", "surge"]),
  config: z.record(z.string(), z.unknown()),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const GET = withAuth(async (_request, { session, params }) => {
  const { eventId, productId } = params as { eventId: string; productId: string };
  try {
    const event = await requireOwnedEvent(eventId, session.accountId);
    const { rules } = await listPricingRules(event.event_id, productId);
    return successResponse(
      rules.map((r) => ({
        id: r.rule_id,
        ruleType: r.rule_type,
        config: r.config,
        priority: r.priority,
        isActive: r.is_active,
        createdAt: r.created_at,
      })),
    );
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "상품을 찾을 수 없습니다",
      unavailableMessage: "가격 규칙을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId, productId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});

export const POST = withAuth(async (request, { session, params }) => {
  const { eventId, productId } = params as { eventId: string; productId: string };
  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    const event = await requireOwnedEvent(eventId, session.accountId);
    const created = await createPricingRule(event.event_id, productId, {
      rule_type: body.ruleType,
      config: body.config,
      priority: body.priority ?? 0,
      is_active: body.isActive ?? true,
    });
    return successResponse({
      id: created.rule_id,
      ruleType: created.rule_type,
      config: created.config,
      priority: created.priority,
      isActive: created.is_active,
    });
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "상품을 찾을 수 없습니다",
      unavailableMessage: "가격 규칙을 생성하지 못했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId, productId },
    });
    if (mapped) return mapped;
    return errorResponse(ERR.SERVER, 500);
  }
});

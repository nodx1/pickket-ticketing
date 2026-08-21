/**
 * 좌석 등급 목록/생성 — 레벨2 컷오버 wave2 **W2-PS**.
 *
 * ## 이전 → 현재
 * 이전엔 go `seat_tiers` 가 정의(색상/표시순서/뷰 메타)를 갖고 v2 는 커머스 값만 알았다.
 * 그래서 목록은 go read + v2 보강이라는 하이브리드였고, **v2 조회 실패를 `soldCount = 0`·
 * go 미러값으로 흡수**했다. 지금은 v2 `seat_tiers` 가 유일 저장소다 —
 * 조회 실패는 흡수하지 않고 **503**(`catalogErrorResponse`).
 *
 * ## capacity 0 이 정상인 이유
 * 좌석 등급의 정원은 좌석 배치도에서 파생된다(`syncCapacityFromLayout`). 등급을 먼저 만들고
 * 좌석을 나중에 그리는 순서가 정상 워크플로라 **생성 시 capacity=0** 이 온다(빌더 tier-manager 가
 * 실제로 그렇게 보낸다). 종전 v2 계약은 `capacity > 0` 을 강제해 이 생성이 **422 → 502** 로
 * 실패했다 — alembic `w2ps_0727` + `TierUpsert(ge=0)` 로 해소됐다.
 */
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { requireOwnedEvent } from "@/lib/v2/event-access";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import {
  loadCatalog,
  saveCatalogEntry,
  selectSeatTiers,
  toSeatTierUpsert,
  toSeatTierView,
} from "@/lib/v2/tier-catalog";

type Params = { eventId: string };

const createSchema = z.object({
  name: z.string().min(1, "티어 이름을 입력해주세요").max(100),
  capacity: z.number().int().min(0).max(100_000),
  basePrice: z.number().int().min(0),
  facePrice: z.number().int().min(0).optional(),
  saleMode: z
    .enum(["membership_presale", "lottery", "queue_sale", "fcfs_residual"])
    .optional(),
  seatMapId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
  colorHex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "색상은 #RRGGBB 형식이어야 합니다")
    .optional(),
  displayOrder: z.number().int().min(0).max(999).optional(),
});

const NOT_FOUND_MESSAGE = "이벤트를 찾을 수 없습니다";
const UNAVAILABLE_MESSAGE = "좌석 등급을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.";

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const entries = await loadCatalog(event.event_id);
    const tiers = selectSeatTiers(entries).map((e) =>
      toSeatTierView(e, session.accountId, params.eventId),
    );
    return listResponse(tiers, tiers.length);
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: NOT_FOUND_MESSAGE,
      unavailableMessage: UNAVAILABLE_MESSAGE,
      context: { eventId: params.eventId },
    });
    if (mapped) return mapped;
    throw err;
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("입력값을 확인해주세요", 400);
  }

  try {
    // 소유 검증(v2 organizer_ref 가 테넌트 경계 강제) — 미소유/미존재 404, v2 장애 503.
    const event = await requireOwnedEvent(params.eventId, session.accountId);

    // 등급 id 는 앱이 발급해 v2 external_ref 로 보존한다(좌석 배치도 tierId 참조가 이 값).
    const tierId = crypto.randomUUID();
    await saveCatalogEntry(
      event.event_id,
      toSeatTierUpsert({
        ref: tierId,
        name: body.name,
        capacity: body.capacity,
        basePrice: body.basePrice,
        facePrice: body.facePrice ?? body.basePrice,
        saleMode: body.saleMode,
        colorHex: body.colorHex ?? null,
        displayOrder: body.displayOrder ?? 0,
        seatMapId: body.seatMapId ?? null,
        productId: body.productId ?? null,
      }),
      // 멱등키 = 등급 id → 네트워크 재시도 시 같은 티어로 수렴(이중생성 방지).
      `tier-create:${tierId}`,
    );

    const entries = await loadCatalog(event.event_id);
    const created = selectSeatTiers(entries).find((e) => e.ref === tierId);
    return successResponse(
      created
        ? { ...toSeatTierView(created, session.accountId, params.eventId), v2TierId: created.row.tier_id }
        : { id: tierId },
      201,
    );
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: NOT_FOUND_MESSAGE,
      unavailableMessage:
        "좌석 등급 생성 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId: params.eventId },
    });
    if (mapped) return mapped;
    return errorResponse("좌석 등급을 생성하지 못했습니다", 400);
  }
});

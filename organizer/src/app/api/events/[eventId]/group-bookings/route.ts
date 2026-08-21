/**
 * 단체예약 목록·신청 — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * go `group_bookings` 테이블을 v2 `group_bookings` 로 옮겼다. 부수적으로 이 라우트에 남아
 * 있던 **죽은 go 테이블 읽기 2건**도 v2 카탈로그로 대체한다:
 *   - `INNER JOIN products` (상품명)      → v2 티어 카탈로그가 목록 응답에 실어 준다.
 *   - `SELECT ... FROM seat_tiers` (단체 허용/최대 인원) → v2 티어 메타(W2-PS 흡수분).
 * 두 테이블은 writer 0(마이그 248 참조)이라 초기화 후 **항상 빈 상태**였고, 그대로 두면
 * 좌석 단체 할당이 언제나 "티어를 찾을 수 없습니다(404)" 로 죽는다.
 *
 * ## 실패 취급
 * 신청(POST)은 비인증 공개 경로다. 옛 catch 는 모든 실패를 400 "단체 예약 신청에 실패했습니다"
 * 로 뭉갰다 — 신청자가 자기 입력을 의심하고 재시도하지 않는다.
 *   - 없는 행사/상품 → 404 · v2 장애 → 503 · 입력 위반 → 400.
 */
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { allocateGroup } from "@/lib/seats/group-allocator";
import { requireFeature } from "@/lib/server/require-feature";
import { catalogErrorResponse } from "@/lib/v2/catalog-http";
import {
  V2CommerceError,
  createGroupBooking,
  getEvent,
  listGroupBookings,
} from "@/lib/v2/commerce-client";
import { requireOwnedEvent } from "@/lib/v2/event-access";
import { loadCatalog } from "@/lib/v2/tier-catalog";

type Params = { eventId: string };

const schema = z.object({
  organizationName: z.string().min(2, "단체명을 입력해주세요"),
  contactName: z.string().min(2, "담당자명을 입력해주세요"),
  contactEmail: z.email("올바른 이메일을 입력해주세요"),
  contactPhone: z.string().optional(),
  attendeeCount: z.number().int().min(2, "최소 2명 이상이어야 합니다"),
  productId: z.string().uuid("상품을 선택해주세요"),
  tierId: z.string().uuid().optional(),
  leaderId: z.string().uuid().optional(),
  memberIds: z.array(z.string().uuid()).optional(),
  notes: z.string().optional(),
});

export const GET = withRole<Params>("staff", async (_request, { session, params }) => {
  const featureBlock = await requireFeature(params.eventId, session.accountId, "group_booking");
  if (featureBlock) return featureBlock;
  try {
    const event = await requireOwnedEvent(params.eventId, session.accountId);
    const { bookings } = await listGroupBookings(event.event_id);
    const rows = bookings.map((b) => ({
      id: b.booking_id,
      organizationName: b.organization_name,
      contactName: b.contact_name,
      contactEmail: b.contact_email,
      contactPhone: b.contact_phone,
      attendeeCount: b.attendee_count,
      discountRate: b.discount_rate,
      status: b.status,
      notes: b.notes,
      createdAt: b.created_at,
      productName: b.product_name,
      orderNumber: b.order_number,
    }));
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "이벤트를 찾을 수 없습니다",
      unavailableMessage: "단체 예약 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId: params.eventId },
    });
    if (mapped) return mapped;
    throw err;
  }
});

export async function POST(request: Request, context: { params: Promise<Params> }) {
  const { eventId } = await context.params;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    return errorResponse("입력값을 확인해주세요", 400);
  }

  try {
    // ── W2-ORD: go `SELECT account_id, v2_event_id FROM events` 폐기 ──
    // 비인증(공개 단체예약 신청) 라우트라 accountId 를 eventId 에서 역해석해야 하는데,
    // 그 값은 v2 이벤트 상세의 go_account_id 가 정본이다. v2 event id 는 항등.
    // 🔴 fail-closed: v2 404 = 없는 행사(404), v2 5xx = 503.
    let eventDetail: Awaited<ReturnType<typeof getEvent>>;
    try {
      eventDetail = await getEvent(eventId);
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
        return errorResponse("행사 정보를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      throw err;
    }
    const accountId = eventDetail.go_account_id;
    if (!accountId) {
      return errorResponse("이벤트를 찾을 수 없습니다", 404);
    }
    const featureBlock = await requireFeature(eventId, accountId, "group_booking");
    if (featureBlock) return featureBlock;

    // Phase 8: 좌석 + tier 이 있으면 좌석 인접 할당 시도.
    // ── 레벨2 컷오버 T1 ── 좌석/배치도가 go 에서 사라져 활성 맵을 go 에서 고를 수 없다.
    //   좌석 SoT 는 v2 이므로 좌석 후보 탐색·홀드는 allocateGroup 이 v2 재고 API 로 수행한다.
    const v2EventId = eventDetail.event_id;

    // ★ 트랜잭션 경계: v2 재고 홀드(외부호출)는 예약 기록 write **밖**에서 먼저 끝낸다.
    //   홀드 후 예약 기록이 실패하면 홀드는 TTL·reaper 가 회수한다.
    let allocation: {
      seatIds: string[];
      holdId: string;
      holdToken: string;
      expiresAt: string;
    } | null = null;

    if (body.tierId && body.leaderId) {
      // ── W5-COMMERCE: 단체 허용/최대 인원은 v2 티어 메타가 정본(go seat_tiers 는 죽은 표) ──
      const entries = await loadCatalog(v2EventId);
      const tierEntry = entries.find((e) => e.ref === body.tierId);
      if (!tierEntry) {
        return errorResponse("티어를 찾을 수 없습니다", 404);
      }
      if (tierEntry.row.allow_group_tickets === false) {
        return errorResponse("단체 구매가 허용되지 않은 티어입니다", 400);
      }

      const memberIds = body.memberIds ?? [];
      if (memberIds.length + 1 !== body.attendeeCount) {
        return errorResponse(
          "단체 좌석 할당에는 리더를 제외한 나머지 멤버 ID 를 제공해야 합니다",
          400,
        );
      }
      const result = await allocateGroup({
        v2EventId,
        tierId: body.tierId,
        request: {
          leaderId: body.leaderId,
          memberIds,
          tierId: body.tierId,
          size: body.attendeeCount,
        },
        maxGroupSize: Number(tierEntry.row.max_group_size ?? 4),
        heldBy: body.leaderId,
      });

      if (!result.success || !result.allocated) {
        return errorResponse(result.error ?? "단체 좌석 할당에 실패했습니다", 409);
      }
      allocation = result.allocated;
    }

    const created = await createGroupBooking(v2EventId, {
      product_ref: body.productId,
      organization_name: body.organizationName,
      contact_name: body.contactName,
      contact_email: body.contactEmail,
      contact_phone: body.contactPhone ?? null,
      attendee_count: body.attendeeCount,
      notes: body.notes ?? null,
    });

    return successResponse({ id: created.booking_id, allocation }, 201);
  } catch (err: unknown) {
    const mapped = catalogErrorResponse(err, {
      notFoundMessage: "상품 또는 이벤트를 찾을 수 없습니다",
      unavailableMessage: "단체 예약 신청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
      context: { eventId },
    });
    if (mapped) return mapped;
    return errorResponse("단체 예약 신청에 실패했습니다", 500);
  }
}

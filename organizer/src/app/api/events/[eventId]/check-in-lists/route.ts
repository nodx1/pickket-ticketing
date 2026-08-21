import { z } from "zod";
import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  createCheckInList,
  listCheckInLists,
  listCheckInLogs,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

/**
 * 레벨2 컷오버 W5-ATTENDEE — 체크인 명단·최근 로그를 v2 정본에서 읽는다.
 * (옛 go `check_in_lists` / `check_in_logs` 직접 SQL 폐기. mig252 로 두 테이블 DROP.)
 *
 * 🔴 fail-closed: v2 조회 실패를 **빈 목록으로 강등하지 않는다**. 현장 화면에서 명단 0건은
 *    "명단을 안 만들었다"로, 최근 체크인 0건은 "아무도 안 들어왔다"로 읽힌다 → 503.
 */
type Params = { eventId: string };

const schema = z.object({
  name: z.string().min(2, "리스트 이름은 2자 이상이어야 합니다"),
  productIds: z.array(z.string().uuid()).default([]),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
});

const UNAVAILABLE = "체크인 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.";

// 🔴 스캔 API(`POST /check-in`)는 staff 를 요구하는데 이 조회가 organizer 를 요구하면
//    게이트 스태프가 **화면 자체를 못 연다**(리스트가 비어 "체크인 리스트가 없습니다" 오안내).
//    체크인 리스트는 게이트 운영에 필수이고 민감도가 낮아 스캔과 같은 staff 로 맞춘다.
//    ⚠️ 아래 쓰기(POST/PATCH/DELETE)는 organizer 유지 — 스태프가 리스트를 바꾸면 안 된다.
export const GET = withRole<Params>("staff", async (request, { session, params }) => {
  const { searchParams } = new URL(request.url);
  const listId = searchParams.get("listId");

  try {
    const [lists, logs] = await Promise.all([
      listCheckInLists(params.eventId, session.accountId),
      listCheckInLogs(params.eventId, session.accountId, {
        checkInListId: listId,
        limit: 10,
      }),
    ]);

    return successResponse({
      items: lists.lists.map((l) => ({
        id: l.id,
        name: l.name,
        status: l.status,
        productIds: l.product_ids,
        opensAt: l.opens_at,
        closesAt: l.closes_at,
      })),
      recentLogs: logs.logs.map((log) => ({
        id: log.id,
        // undo(입장취소) 대상 키 = v2 ticket_id. 체크인 응답의 attendee.id 와 동일 식별자.
        attendeeId: log.ticket_id,
        name: log.attendee_name,
        ticketNumber: log.ticket_number,
        // 최근 10건 위젯에 상품명 하나 채우려고 티켓당 단건조회를 돌리지 않는다(기존 동작 유지).
        productName: null,
        method: log.method,
        attendedDate: log.attended_date,
        createdAt: log.created_at,
      })),
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse(UNAVAILABLE, 503);
    }
    throw err;
  }
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const body = schema.parse(await request.json());
    const { list } = await createCheckInList(params.eventId, session.accountId, {
      name: body.name,
      product_ids: body.productIds,
      opens_at: body.opensAt ? toIsoFromKstLocal(body.opensAt) : null,
      closes_at: body.closesAt ? toIsoFromKstLocal(body.closesAt) : null,
      status: "active",
    });

    return successResponse(
      {
        id: list.id,
        name: list.name,
        status: list.status,
        productIds: list.product_ids,
        opensAt: list.opens_at,
        closesAt: list.closes_at,
      },
      201,
    );
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
      return errorResponse(UNAVAILABLE, 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

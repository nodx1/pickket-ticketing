/**
 * 티켓 디자이너 / 초대권 편집기 canvas — 레벨2 W5-CONTENT.
 *
 * go `ticket_designs` → v2 `organizer_ticket_designs` 이관. go DB read/write 0.
 * 테넌트 경계는 v2 가 `organizer_ref`(= session.accountId) 로 강제한다(불일치 → 404).
 *
 * PUT 은 **전체교체가 아니라 top-level 병합**이다(v2 가 병합). 티켓 디자이너와 초대권
 * 편집기가 같은 문서를 공유하므로, 한쪽 저장이 다른 쪽 필드를 지우면 안 된다
 * (go 시절 jsonb `||` 와 동일 시맨틱).
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  getOrganizerTicketDesign,
  putOrganizerTicketDesign,
} from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";

type Params = { eventId: string };

// 헥스 색상(#RGB/#RRGGBB) — accentColor 검증(F5 초대권 브랜딩).
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// 티켓 디자이너(기존) 필드. 부분 PATCH 를 위해 전 필드 optional — 넘어온 키만 canvas_json 에 병합.
const schema = z.object({
  logoImageUrl: z.string().optional(),
  backgroundColor: z.string().optional(),
  textColor: z.string().optional(),
  qrPosition: z.enum(["top", "center", "bottom"]).optional(),
  qrSize: z.enum(["sm", "md", "lg"]).optional(),
  showEventName: z.boolean().optional(),
  showDate: z.boolean().optional(),
  showVenue: z.boolean().optional(),
  showAttendeeName: z.boolean().optional(),
  showProductName: z.boolean().optional(),
  fontScale: z.number().min(0.8).max(1.4).optional(),
  // ── F5 초대권 편집 필드 — 공개 초대권 뷰(tickets/[ticketNumber])가 소비 ──
  accentColor: z.string().regex(HEX, "색상 형식(#RRGGBB)이 올바르지 않습니다").optional(),
  logoUrl: z.string().max(2000).optional(),
  invitationHeaderText: z.string().max(120).optional(),
  showRaffleNumber: z.boolean().optional(),
  showGallery: z.boolean().optional(),
});

const NOT_FOUND = "이벤트를 찾을 수 없습니다";

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const { canvas_json } = await getOrganizerTicketDesign(params.eventId, session.accountId);
    return successResponse(canvas_json ?? {});
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const PUT = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err: unknown) {
    // 입력 검증만 400 — v2 장애가 여기로 흘러들어와 400 으로 뭉개지지 않도록 catch 를 분리한다.
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    await putOrganizerTicketDesign(params.eventId, session.accountId, body);
    return successResponse({ saved: true });
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

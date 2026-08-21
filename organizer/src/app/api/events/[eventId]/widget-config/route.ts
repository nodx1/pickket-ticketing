/**
 * 주최자 위젯(embed) 설정 — 레벨2 W5-CONTENT.
 *
 * go `widget_configs` → v2 `organizer_widget_configs` 이관. go DB read/write 0.
 * 테넌트 경계는 v2 가 `organizer_ref`(= session.accountId) 로 강제한다(불일치 → 404).
 *
 * 🔴 `allowedDomains` 는 외부 사이트 embed 허용 화이트리스트다. v2 조회 실패를 빈 목록
 *    (= 제한 없음)으로 폴백하면 아무 사이트나 위젯을 박을 수 있게 된다 → fail-closed(503).
 *    "행이 없어서 빈 목록"(configured=false, go 기존 동작)과 "못 읽음"은 v2 응답에서 구분된다.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  getOrganizerWidgetConfig,
  putOrganizerWidgetConfig,
} from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";

type Params = { eventId: string };

const widgetConfigSchema = z.object({
  mode: z.enum(["button", "inline", "mini"]).optional(),
  theme: z.object({
    primaryColor: z.string().optional(),
    buttonText: z.string().optional(),
    borderRadius: z.number().optional(),
    fontFamily: z.string().optional(),
  }).optional(),
  allowedDomains: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

// 설정 행이 아직 없을 때 화면에 보여줄 기본값(go 기존 동작 보존).
const DEFAULT_CONFIG = {
  mode: "button",
  theme: {
    primaryColor: "#6C5CE7",
    buttonText: "티켓 구매",
    borderRadius: 100,
    fontFamily: "",
  },
  allowedDomains: [] as string[],
  isActive: true,
};

const NOT_FOUND = "이벤트를 찾을 수 없습니다";

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    const config = await getOrganizerWidgetConfig(params.eventId, session.accountId);
    if (!config.configured) return successResponse(DEFAULT_CONFIG);
    return successResponse({
      mode: config.mode,
      theme: config.theme,
      allowedDomains: config.allowed_domains,
      isActive: config.is_active,
      updatedAt: config.updated_at ?? null,
    });
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const PUT = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof widgetConfigSchema>;
  try {
    body = widgetConfigSchema.parse(await request.json());
  } catch (err: unknown) {
    // 입력 검증만 400. v2 장애를 400 으로 뭉개지 않도록 파싱과 원격호출의 catch 를 분리한다.
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    const saved = await putOrganizerWidgetConfig(params.eventId, session.accountId, {
      mode: body.mode ?? "button",
      theme: body.theme ?? {},
      allowed_domains: body.allowedDomains ?? [],
      is_active: body.isActive ?? true,
    });
    return successResponse({
      mode: saved.mode,
      theme: saved.theme,
      allowedDomains: saved.allowed_domains,
      isActive: saved.is_active,
      updatedAt: saved.updated_at ?? null,
    });
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

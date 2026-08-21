import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";
import { applySalePlan, salePlanErrorMessage } from "@/lib/v2/phase-client";
import type { MainSaleMode, SalePlanPhaseInput } from "@/lib/v2/phase-client";

type Params = { eventId: string };

/**
 * 판매 방식 적용 — v2 `PUT /internal/events/{id}/sale-plan` 프록시.
 *
 * 레벨2 컷오버 T2-PHASE: 검증(간격 96h·비율합 100·모드중복·이벤트 시작 이전 종료)과
 * 시퀀스 생성(waitlist_promotion + fcfs_residual 자동 부가)은 **v2 서비스가 수행**한다.
 * 여기 zod 는 형식 검증만 담당하고 비즈니스 규칙은 v2 한 곳에만 둔다(이중 정본 금지).
 *
 * ⚠️ 이 경로가 phase 의 정본 writer 다. 이전에는 go DB 에만 쓰고 v2 는 "심사 요청"
 * 웹훅으로만 갱신돼, 승인 이후의 변경이 v2 자동 추첨·FCFS 전환에 영영 반영되지 않았다.
 *
 * 신규 스키마 — 복수 phase 조합 지원.
 * phases 가 비어있고 fcfsOpensAt 만 있으면 순수 선착순 이벤트.
 * 1개 이상 있으면 뒤에 waitlist_promotion + fcfs_residual 자동 추가.
 */
const multiPhaseSchema = z.object({
  phases: z
    .array(
      z.object({
        mode: z.enum(["membership_presale", "lottery", "queue_sale"]),
        ratioPct: z.number().min(0).max(100),
        opensAt: z.string().datetime({ offset: true }),
        closesAt: z.string().datetime({ offset: true }),
        fanclubId: z.string().uuid().optional(),
      }),
    )
    .max(3),
  fcfsOpensAt: z.string().datetime({ offset: true }).optional(),
});

/**
 * 레거시 스키마 — 단일 모드 (하위 호환).
 * 내부에서 SalePlanPhaseInput[] 으로 변환됨.
 */
const legacySchema = z.object({
  mode: z.enum(["membership_presale", "lottery", "queue_sale", "fcfs_residual"]),
  opensAt: z.string().datetime({ offset: true }),
  closesAt: z.string().datetime({ offset: true }).nullable().optional(),
  fanclubId: z.string().uuid().optional(),
});

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  try {
    const raw = await request.json();

    // 신규 스키마 우선 시도, 실패 시 레거시로 fallback
    let phases: SalePlanPhaseInput[];
    let fcfsOpensAt: Date | undefined;

    const multi = multiPhaseSchema.safeParse(raw);
    if (multi.success) {
      phases = multi.data.phases.map((p) => ({
        mode: p.mode as MainSaleMode,
        ratioPct: p.ratioPct,
        opensAt: new Date(p.opensAt),
        closesAt: new Date(p.closesAt),
        fanclubId: p.fanclubId,
      }));
      fcfsOpensAt = multi.data.fcfsOpensAt ? new Date(multi.data.fcfsOpensAt) : undefined;
    } else {
      const legacy = legacySchema.parse(raw);
      // 레거시 → SalePlanPhaseInput 변환
      if (legacy.mode === "fcfs_residual") {
        phases = [];
        fcfsOpensAt = new Date(legacy.opensAt);
      } else {
        if (!legacy.closesAt) {
          return errorResponse("추첨/멤버십 모드는 마감 시각 필수", 400);
        }
        phases = [
          {
            mode: legacy.mode as MainSaleMode,
            ratioPct: 100,
            opensAt: new Date(legacy.opensAt),
            closesAt: new Date(legacy.closesAt),
            fanclubId: legacy.fanclubId,
          },
        ];
      }
    }

    const result = await applySalePlan(
      params.eventId,
      session.accountId,
      phases,
      fcfsOpensAt,
    );
    if (!result) return errorResponse(ERR.NOT_FOUND, 404);

    return successResponse({ phases: result }, 201);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    if (err instanceof V2CommerceError) {
      // v2 검증 실패(한국어 메시지)는 그대로 주최자에게 전달. 4xx 는 입력 오류,
      // 5xx/네트워크는 저장 자체가 안 된 것이므로 502 로 구분한다.
      const status = err.status >= 400 && err.status < 500 ? 400 : 502;
      return errorResponse(
        salePlanErrorMessage(err, "판매 방식을 설정하지 못했습니다"),
        status,
      );
    }
    // 소유 확인 자체가 불가한 v2 장애 — 아래 폴백(400)이 "입력값 문제"로 뭉개면
    // 주최자가 판매계획을 계속 고쳐 쓰며 헛수고한다. 재시도 가능 신호로 분리한다.
    if (err instanceof EventAccessError) {
      return errorResponse("커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    return errorResponse(
      err instanceof Error ? err.message : "판매 방식을 설정하지 못했습니다",
      400,
    );
  }
});
